#!/usr/bin/env python3
"""
OpenRouter Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on OpenRouter using either TempMail-Pro or Google OAuth (GSuite),
handles Cloudflare Turnstile, completes onboarding, generates API keys with
custom settings (No Expiration, No Limit), resolves Clerk reverification OTP,
and saves tokens.
"""

from __future__ import annotations
import argparse
import asyncio
import base64
from collections import deque
import concurrent.futures
import json
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Tuple, Union
from urllib.parse import urlparse
import requests

# Ensure repo root is on sys.path so packages.camoufox_core can be imported
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
    kill_descendant_processes,
    cleanup_leftover_browser_processes,
    cleanup_temp_profiles,
    get_vps_system_status,
    safe_close_browser,
    TempMailClient,
    resolve_turnstile_if_present,
    dismiss_turnstile_modal,
    perform_google_oauth,
    GooglePhoneVerificationException,
)
from packages.camoufox_core.turnstile import find_turnstile_target

API_KEY_RE = re.compile(r"\bsk-or-v1-[A-Za-z0-9_\-]{30,}\b")
VERIFY_LINK_RE = re.compile(
    r"https?://(?:clerk\.)?openrouter\.ai/(?:v1/verify|sign-up/verify)[^\s\"'<>]+",
    re.IGNORECASE,
)

DEFAULT_SIGNUP_URL = "https://openrouter.ai/sign-up"
ONBOARDING_URL = "https://openrouter.ai/onboarding"
DASHBOARD_URL = "https://openrouter.ai/workspaces/default"
API_KEYS_URL = "https://openrouter.ai/workspaces/default/keys"

FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Chris", "Pat", "Riley", "Casey", "Avery", "Jamie", "Logan"]
LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Taylor", "Anderson"]

def generate_random_name() -> Tuple[str, str]:
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)

def extract_proxy_address(proxy_str: str) -> str:
    try:
        u = proxy_str if "://" in proxy_str else f"http://{proxy_str}"
        return urlparse(u).hostname or proxy_str
    except Exception:
        return proxy_str

def check_proxy_single_sync(
    proxy: Proxy,
    target_url: str = DEFAULT_SIGNUP_URL,
    timeout_sec: float = 6.0,
) -> Tuple[Proxy, bool, Union[int, str], float]:
    """Probes candidate proxy by performing a synchronous HTTP GET to target_url."""
    t0 = time.time()
    try:
        parsed = urlparse(proxy.server)
        scheme = parsed.scheme or "http"
        host_port = parsed.netloc or parsed.path
        if proxy.username and proxy.password:
            proxy_url = f"{scheme}://{proxy.username}:{proxy.password}@{host_port}"
        else:
            proxy_url = f"{scheme}://{host_port}"

        proxies = {
            "http": proxy_url,
            "https": proxy_url,
        }
        resp = requests.get(
            target_url,
            proxies=proxies,
            timeout=timeout_sec,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            },
            allow_redirects=True,
        )
        dt = round(time.time() - t0, 2)
        is_ok = resp.status_code == 200
        return proxy, is_ok, resp.status_code, dt
    except Exception as e:
        dt = round(time.time() - t0, 2)
        reason = type(e).__name__
        return proxy, False, reason, dt

def check_proxy_batch_sync(
    candidates: List[Proxy],
    target_url: str = DEFAULT_SIGNUP_URL,
    timeout_sec: float = 6.0,
    max_threads: int = 15,
) -> List[Tuple[Proxy, bool, Union[int, str], float]]:
    results: List[Tuple[Proxy, bool, Union[int, str], float]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(candidates), max_threads)) as executor:
        future_map = {
            executor.submit(check_proxy_single_sync, p, target_url, timeout_sec): p
            for p in candidates
        }
        for future in concurrent.futures.as_completed(future_map):
            try:
                res = future.result()
                results.append(res)
            except Exception:
                p = future_map[future]
                results.append((p, False, "ThreadError", 0.0))
    return results

class SmartProxyPool:
    """Thread-safe and async-safe proxy pool with HTTP 200 pre-checks."""
    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies = deque(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: Set[str] = set()
        self.reuse_proxy = reuse_proxy
        self.lock = asyncio.Lock()

    def address_of(self, proxy: Proxy) -> str:
        return extract_proxy_address(proxy.server)

    @property
    def has_proxies(self) -> bool:
        return len(self.fresh_proxies) > 0 or len(self.good_proxies) > 0

    @property
    def fresh_count(self) -> int:
        return len(self.fresh_proxies)

    @property
    def good_count(self) -> int:
        return len(self.good_proxies)

    def get_next_proxy(self) -> Optional[Proxy]:
        if self.reuse_proxy and self.good_proxies:
            p = self.good_proxies.pop(0)
            self.good_proxies.append(p)
            return p

        while self.fresh_proxies:
            p = self.fresh_proxies.popleft()
            addr = self.address_of(p)
            if addr not in self.bad_addresses:
                return p

        if self.good_proxies:
            p = self.good_proxies.pop(0)
            self.good_proxies.append(p)
            return p

        return None

    async def get_next_live_proxy(
        self,
        target_url: str = DEFAULT_SIGNUP_URL,
        timeout_sec: float = 6.0,
        logger = None,
        batch_size: int = 15,
        enable_precheck: bool = True,
    ) -> Optional[Proxy]:
        if not enable_precheck:
            async with self.lock:
                return self.get_next_proxy()

        async with self.lock:
            if self.reuse_proxy and self.good_proxies:
                p = self.good_proxies.pop(0)
                self.good_proxies.append(p)
                return p

        while True:
            candidates: List[Proxy] = []
            async with self.lock:
                if self.good_proxies:
                    p = self.good_proxies.pop(0)
                    if self.reuse_proxy:
                        self.good_proxies.append(p)
                    return p

                while self.fresh_proxies and len(candidates) < batch_size:
                    cand = self.fresh_proxies.popleft()
                    addr = self.address_of(cand)
                    if addr not in self.bad_addresses:
                        candidates.append(cand)

                if not candidates:
                    if self.good_proxies:
                        p = self.good_proxies.pop(0)
                        if self.reuse_proxy:
                            self.good_proxies.append(p)
                        return p
                    return None

            if logger:
                logger.info(
                    f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against OpenRouter (HTTP 200, timeout={timeout_sec}s)... "
                    f"(Fresh remaining: {len(self.fresh_proxies)}, Good pool: {len(self.good_proxies)})"
                )

            results = await asyncio.to_thread(
                check_proxy_batch_sync,
                candidates,
                target_url,
                timeout_sec,
            )

            good_candidates: List[Proxy] = []
            bad_count = 0

            for cand, ok, status_or_reason, latency in results:
                addr = self.address_of(cand)
                if ok:
                    good_candidates.append(cand)
                    if logger:
                        logger.info(f"✅ Proxy pre-check PASSED: {cand.server} ({addr}) -> HTTP 200 in {latency}s")
                else:
                    async with self.lock:
                        self.bad_addresses.add(addr)
                    bad_count += 1

            if bad_count > 0 and logger:
                logger.info(f"⏭️ Discarded {bad_count} dead/non-200 proxies from batch.")

            if good_candidates:
                selected = good_candidates[0]
                if len(good_candidates) > 1:
                    async with self.lock:
                        for extra in good_candidates[1:]:
                            if extra not in self.good_proxies:
                                self.good_proxies.append(extra)
                return selected

    def mark_result(self, proxy: Optional[Proxy], success: bool):
        if not proxy:
            return
        addr = self.address_of(proxy)
        if success:
            if proxy not in self.good_proxies:
                self.good_proxies.append(proxy)
        else:
            self.bad_addresses.add(addr)
            self.good_proxies = [p for p in self.good_proxies if self.address_of(p) != addr]
            self.fresh_proxies = deque(p for p in self.fresh_proxies if self.address_of(p) != addr)

# ── Step Handlers ──────────────────────────────────────────────────────────

async def handle_onboarding(page, logger) -> bool:
    """Handles multi-step OpenRouter onboarding surveys and navigation."""
    logger.info("checking and handling onboarding steps...")

    for cycle in range(15):
        current_url = page.url or ""
        if "/workspaces/default/keys" in current_url:
            logger.info("already reached keys page.")
            return True

        # 1. Welcome Screen ("Welcome to OpenRouter" -> Next)
        welcome_next = page.locator('button:has-text("Next")')
        if await welcome_next.count() > 0 and await welcome_next.first.is_visible():
            logger.info("[onboarding] clicking 'Next' on welcome screen...")
            await welcome_next.first.click()
            await human_delay(1500, 2500)
            continue

        # 2. Acquisition question ("Where did you first hear..." -> Radio + Continue)
        radio_opt = page.locator('button[role="radio"], label:has-text("Friend"), span:has-text("Friend"), span:has-text("X / Twitter"), label:has-text("Search")')
        if await radio_opt.count() > 0 and await radio_opt.first.is_visible():
            logger.info("[onboarding] selecting acquisition survey option...")
            await radio_opt.first.click()
            await human_delay(600, 1000)

            continue_btn = page.locator('button:has-text("Continue")')
            if await continue_btn.count() > 0 and await continue_btn.first.is_visible():
                await continue_btn.first.click()
                await human_delay(1500, 2500)
                continue

        # 3. Payment Method ("Add a payment method" -> I'll do this later)
        later_btn = page.locator('button:has-text("I\'ll do this later"), button:has-text("do this later")')
        if await later_btn.count() > 0 and await later_btn.first.is_visible():
            logger.info("[onboarding] clicking 'I\\'ll do this later'...")
            await later_btn.first.click()
            await human_delay(1500, 2500)
            continue

        # 4. You're all set! -> Click "Get API Key"
        get_key_btn = page.locator('button:has-text("Get API Key")')
        if await get_key_btn.count() > 0 and await get_key_btn.first.is_visible():
            logger.info("[onboarding] clicking 'Get API Key'...")
            await get_key_btn.first.click()
            await human_delay(2000, 3000)
            break

        # Check if already on workspaces or dashboard
        if "/workspaces" in current_url or "/dashboard" in current_url:
            break

        await asyncio.sleep(1)

    return True

async def create_and_extract_api_key(
    page,
    email: str,
    temp_mail: Optional[TempMailClient],
    auth_method: str,
    screenshot_dir: str,
    logger,
) -> str:
    """Navigates to /workspaces/default/keys, creates key, handles OTP if prompted, and returns token."""
    # Ensure onboarding is complete
    if "/onboarding" in (page.url or ""):
        await handle_onboarding(page, logger)

    logger.info(f"navigating to API keys page: {API_KEYS_URL}")
    await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
    await human_delay(2000, 3000)

    # In case of redirect back to onboarding
    if "/onboarding" in (page.url or ""):
        await handle_onboarding(page, logger)
        await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
        await human_delay(2000, 3000)

    # Install clipboard capture hook
    try:
        await page.evaluate("""() => {
            if (!window.__cbHookInstalled) {
                window.__cbHookInstalled = true;
                window.__copied_key = null;
                if (navigator.clipboard) {
                    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
                    navigator.clipboard.writeText = (text) => {
                        window.__copied_key = text;
                        return orig(text);
                    };
                }
            }
        }""")
    except Exception:
        pass

    # Click 'Create Key' or 'New Key' or 'Create API Key'
    logger.info("looking for 'Create API Key' / 'New Key' button...")
    create_btn = page.locator(
        'button:has-text("Create API Key"), a:has-text("Create API Key"), '
        'button:has-text("Create Key"), button:has-text("New Key")'
    )
    await create_btn.first.wait_for(state="visible", timeout=25000)
    await create_btn.first.click()
    await human_delay(1500, 2500)

    # Fill Key Name in modal
    random_key_name = f"Key-{random.randint(1000, 9999)}"
    logger.info(f"filling key name: {random_key_name}")
    name_input = page.locator('input#name, input[name="name"], input[placeholder*="Chatbot Key" i]')
    await name_input.first.wait_for(state="visible", timeout=15000)
    await human_type(page, 'input#name, input[name="name"], input[placeholder*="Chatbot Key" i]', random_key_name)
    await human_delay(600, 1000)

    # Expiration: Select "No expiration"
    try:
        exp_btn = page.locator('button[id*="expiration"], button:has-text("Select expiration"), button:has-text("No expiration")')
        if await exp_btn.count() > 0 and await exp_btn.first.is_visible():
            logger.info("selecting 'No expiration'...")
            await exp_btn.first.click()
            await human_delay(600, 1000)
            no_exp_opt = page.locator('div:has-text("No expiration"), [role="option"]:has-text("No expiration"), span:has-text("No expiration")')
            if await no_exp_opt.count() > 0:
                await no_exp_opt.first.click()
                await human_delay(500, 800)
    except Exception as e:
        logger.warning(f"could not set expiration combobox: {e}")

    # Credit limit: Select "No limit"
    try:
        limit_btn = page.locator('button[id*="limit"], button:has-text("Choose a credit limit"), button:has-text("No limit")')
        if await limit_btn.count() > 0 and await limit_btn.first.is_visible():
            logger.info("selecting 'No limit'...")
            await limit_btn.first.click()
            await human_delay(600, 1000)
            no_limit_opt = page.locator('div:has-text("No limit"), [role="option"]:has-text("No limit"), span:has-text("No limit")')
            if await no_limit_opt.count() > 0:
                await no_limit_opt.first.click()
                await human_delay(500, 800)
    except Exception as e:
        logger.warning(f"could not set credit limit combobox: {e}")

    # Submit modal: Click 'Create'
    logger.info("submitting key creation modal...")
    modal_dialog = page.locator('div[role="dialog"]')
    modal_submit = modal_dialog.locator('button:has-text("Create")')
    try:
        await modal_submit.wait_for(state="visible", timeout=10000)
        await modal_submit.click()
    except Exception:
        # Fallback to general create button
        submit_btn = page.locator('button[type="submit"]:has-text("Create"), button:has-text("Create")')
        await submit_btn.first.click()

    await human_delay(2500, 3500)

    # Check for Clerk Reverification Required OTP modal
    otp_input = page.locator('input[data-input-otp="true"], input[aria-label*="verification code" i], input[autocomplete="one-time-code"]')
    if await otp_input.count() > 0 and await otp_input.first.is_visible():
        logger.info("Verification required OTP modal appeared! Fetching OTP code...")
        if auth_method == "tempmail" and temp_mail:
            otp_code = await temp_mail.wait_for_verification_otp(email, timeout_sec=90, logger=logger)
            logger.info(f"received 6-digit OTP code: {otp_code}")
            await otp_input.first.click()
            await human_type(page, 'input[data-input-otp="true"], input[aria-label*="verification code" i]', otp_code)
            await human_delay(1500, 2500)

            # Click Continue if present
            cont_btn = page.locator('div.cl-cardBox button:has-text("Continue"), button:has-text("Continue")')
            if await cont_btn.count() > 0 and await cont_btn.first.is_visible():
                await cont_btn.first.click()
                await human_delay(2500, 3500)
        else:
            logger.warning(f"reverification OTP requested for {email} on {auth_method} auth.")

    # Extract API key
    logger.info("extracting generated API key...")
    api_key: Optional[str] = None

    for attempt in range(25):
        # 1. Try clicking 'Copy' button to trigger clipboard hook
        try:
            copy_btn = page.locator('button[aria-label*="Copy key" i], button:has-text("Copy")')
            if await copy_btn.count() > 0 and await copy_btn.first.is_visible():
                await copy_btn.first.click()
                await asyncio.sleep(0.5)
        except Exception:
            pass

        # 2. Check window.__copied_key
        try:
            copied = await page.evaluate("() => window.__copied_key")
            if copied and isinstance(copied, str):
                m = API_KEY_RE.search(copied)
                if m:
                    api_key = m.group(0)
                    break
        except Exception:
            pass

        # 3. Check onepassword-save-button base64 payload
        try:
            op_val = await page.evaluate("""() => {
                const op = document.querySelector('onepassword-save-button');
                return op ? op.getAttribute('value') : null;
            }""")
            if op_val and isinstance(op_val, str):
                try:
                    decoded = base64.b64decode(op_val).decode("utf-8", errors="ignore")
                    m = API_KEY_RE.search(decoded)
                    if m:
                        api_key = m.group(0)
                        break
                except Exception:
                    pass
        except Exception:
            pass

        # 4. Check code tags
        code_elements = await page.query_selector_all("code")
        for code_el in code_elements:
            text = (await code_el.text_content() or "").strip()
            m = API_KEY_RE.search(text)
            if m:
                api_key = m.group(0)
                break
        if api_key:
            break

        # 5. Check full page content
        content = await page.content() or ""
        m = API_KEY_RE.search(content)
        if m:
            api_key = m.group(0)
            break

        await asyncio.sleep(0.6)

    if not api_key:
        os.makedirs(screenshot_dir, exist_ok=True)
        safe_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
        ss_path = os.path.join(screenshot_dir, f"api_key_fail_{safe_email}.png")
        await page.screenshot(path=ss_path)
        raise RuntimeError(f"Failed to extract OpenRouter API key matching sk-or-v1-... (screenshot: {ss_path})")

    logger.info(f"API key successfully obtained: {api_key[:12]}...")

    # Close modal
    try:
        close_btn = page.locator('button:has-text("Close")')
        if await close_btn.count() > 0 and await close_btn.first.is_visible():
            await close_btn.first.click()
        else:
            await page.keyboard.press("Escape")
    except Exception:
        pass

    return api_key

# ── Main Runner Execution for Single Account ────────────────────────────────

async def run_openrouter_single(
    account: Optional[Account],
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    args: argparse.Namespace,
    temp_mail: TempMailClient,
    logger,
) -> bool:
    auth_method = args.auth or "tempmail"
    email = account.email if account else None
    password = account.password if (account and account.password) else (args.password or "torabikA1#")
    screenshot_dir = os.path.join(REPO_ROOT, "artifacts", "screenshots", "openrouter")
    os.makedirs(screenshot_dir, exist_ok=True)

    # Safeguard: skip if already succeeded in results or state
    if email:
        norm_email = email.strip().lower()
        if norm_email in results.get_successful_emails() or store.is_done(norm_email):
            logger.info(f"safeguard: email {email} already completed. Skipping.")
            return True

    # In TempMail mode: generate email if not provided
    if auth_method == "tempmail" and not email:
        domain = args.domain or "ifqy.net"
        if domain.startswith("temp."):
            domain = domain[5:]
        logger.info(f"creating TempMail address using domain @{domain}...")
        created = await asyncio.to_thread(temp_mail.create_email, domain=domain)
        email = created["email"]

    if not email:
        raise ValueError("No email available for OpenRouter registration")

    store.upsert({"email": email, "password": password, "status": FlowState.PENDING})

    active_browser = None
    try:
        logger.info(f"starting OpenRouter ({auth_method}) signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={args.pace})")
        browser_ctx = await launch_camoufox(
            headless=not args.headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            active_browser = browser
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            fp_info = await get_browser_fingerprint_info(page)
            if fp_info:
                gpu_tag = f" | GPU={fp_info.get('renderer')[:35]}" if fp_info.get('renderer') and fp_info.get('renderer') != 'unknown' else ""
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp_info.get('platform')} | Screen={fp_info.get('screen')} | Viewport={fp_info.get('viewport')} | Cores={fp_info.get('cores')}{gpu_tag} | UA={fp_info.get('ua')}")

            # ── Mode A: Google OAuth ───────────────────────────────────────────
            if auth_method == "google":
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
                await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=45000)
                await human_delay(1500, 2500)

                # Wait for Google OAuth button to be visible
                logger.info("waiting for Google OAuth button in Clerk signup card...")
                google_btn = page.locator('button.cl-socialButtonsIconButton__google, button[data-localization-key*="google"], button:has-text("Continue with Google"), button:has-text("Google")')
                try:
                    await google_btn.first.wait_for(state="visible", timeout=25000)
                except Exception:
                    if "/sign-up" not in (page.url or ""):
                        logger.info("navigating directly to /sign-up...")
                        await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=35000)
                    await google_btn.first.wait_for(state="visible", timeout=20000)

                logger.info("clicking 'Continue with Google'...")
                await google_btn.first.click()
                await human_delay(2000, 3500)

                # Perform Google OAuth
                logger.info(f"performing Google OAuth login for {email}...")
                post_auth_page = await perform_google_oauth(
                    page,
                    email=email,
                    password=password,
                    recovery_email=account.recovery_email if account else None,
                    logger=logger,
                )
                page = post_auth_page

                # Wait for redirect back to OpenRouter
                logger.info("waiting for OAuth redirect back to OpenRouter...")
                redirect_deadline = time.time() + 45
                while time.time() < redirect_deadline:
                    cur_url = page.url or ""
                    if "openrouter.ai" in cur_url and "accounts.google.com" not in cur_url:
                        break
                    await asyncio.sleep(1)

            # ── Mode B: TempMail direct signup ────────────────────────────────
            else:
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
                await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=45000)
                await human_delay(1500, 2500)

                # Check if already logged in
                if "/workspaces" in (page.url or "") or "/dashboard" in (page.url or ""):
                    logger.info("already logged in, skipping registration.")
                else:
                    # Wait for Clerk signup form to mount (email input)
                    logger.info("waiting for Clerk signup form to mount...")
                    email_input = page.locator('input[name="emailAddress"], input[type="email"]')
                    try:
                        await email_input.first.wait_for(state="visible", timeout=30000)
                    except Exception:
                        if "/sign-up" not in (page.url or ""):
                            logger.info("ensuring navigation to /sign-up...")
                            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=35000)
                        await email_input.first.wait_for(state="visible", timeout=25000)

                    first_name, last_name = generate_random_name()
                    logger.info(f"filling Clerk registration form: {first_name} {last_name} <{email}>")

                    # Name inputs if present
                    first_input = page.locator('input[name="firstName"]')
                    if await first_input.count() > 0 and await first_input.first.is_visible():
                        await human_type(page, 'input[name="firstName"]', first_name)
                        await human_delay(200, 400)

                    last_input = page.locator('input[name="lastName"]')
                    if await last_input.count() > 0 and await last_input.first.is_visible():
                        await human_type(page, 'input[name="lastName"]', last_name)
                        await human_delay(200, 400)

                    # Email input
                    email_input = page.locator('input[name="emailAddress"], input[type="email"]')
                    await email_input.first.wait_for(state="visible", timeout=15000)
                    await human_type(page, 'input[name="emailAddress"], input[type="email"]', email)
                    await human_delay(300, 600)

                    # Password input
                    pass_input = page.locator('input[name="password"], input[type="password"]')
                    await pass_input.first.wait_for(state="visible", timeout=15000)
                    await human_type(page, 'input[name="password"], input[type="password"]', password)
                    await human_delay(400, 700)

                    # Check terms checkbox if present
                    terms_cb = page.locator('input[name="legalAccepted"], input[type="checkbox"]')
                    if await terms_cb.count() > 0:
                        try:
                            cb = page.locator('input[name="legalAccepted"]')
                            if await cb.count() > 0:
                                if not await cb.first.is_checked():
                                    await cb.first.check(force=True)
                            elif not await terms_cb.first.is_checked():
                                await terms_cb.first.click()
                        except Exception:
                            try:
                                await page.locator('label[for="legalAccepted-field"], .cl-formFieldCheckboxLabel').first.click()
                            except Exception:
                                pass

                    await human_delay(600, 1000)

                    # Cloudflare Turnstile bot check
                    logger.info("checking for Cloudflare Turnstile on register...")
                    turnstile_solved = await resolve_turnstile_if_present(page, logger)
                    if turnstile_solved:
                        logger.info("✅ Cloudflare Turnstile resolved!")
                        await human_delay(1000, 2000)

                    # Submit registration
                    logger.info("submitting Clerk registration form...")
                    submit_btn = page.locator('button.cl-formButtonPrimary, button[type="submit"]:has-text("Continue"), button:has-text("Continue")')
                    await submit_btn.first.wait_for(state="visible", timeout=10000)
                    await submit_btn.first.click()
                    await human_delay(2500, 4000)

                    # Turnstile check after submit if challenged
                    await resolve_turnstile_if_present(page, logger)

                    # Wait for verification email link from TempMail
                    logger.info(f"waiting for Clerk verification email on {email}...")
                    verify_link = await temp_mail.wait_for_verification_link(
                        address=email,
                        timeout_sec=120,
                        interval_sec=3.0,
                        filter_sender="openrouter",
                        link_pattern=VERIFY_LINK_RE,
                        logger=logger,
                    )
                    logger.info(f"verification link received: {verify_link[:50]}...")
                    store.upsert({"email": email, "status": FlowState.EMAIL_VERIFIED, "verificationLink": verify_link})

                    # Navigate to verification link
                    logger.info(f"navigating to verification link: {verify_link}")
                    await page.goto(verify_link, wait_until="domcontentloaded", timeout=45000)
                    await human_delay(3000, 5000)

                    # Wait for redirect away from verify request
                    logger.info("waiting for Clerk verification redirect...")
                    verify_deadline = time.time() + 45
                    while time.time() < verify_deadline:
                        cur_u = page.url or ""
                        if any(target in cur_u for target in ["/onboarding", "/workspaces", "/dashboard", "/selection"]):
                            break
                        await resolve_turnstile_if_present(page, logger)
                        await asyncio.sleep(1)

            # ── Complete Onboarding ──────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.ONBOARDING})
            await handle_onboarding(page, logger)
            store.upsert({"email": email, "status": FlowState.DASHBOARD})

            # ── Create API Key ───────────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(
                page=page,
                email=email,
                temp_mail=temp_mail,
                auth_method=auth_method,
                screenshot_dir=screenshot_dir,
                logger=logger,
            )

            # ── Mark Done & Save Results ─────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.DONE, "apiKey": api_key})
            results.mark_success(email, password, api_key)

            # Also write key to dataset key file if folder exists
            dataset_key_file = os.path.join(REPO_ROOT, "openrouter-dataset", "apikey-openrouter.txt")
            if os.path.isdir(os.path.dirname(dataset_key_file)):
                try:
                    with open(dataset_key_file, "a", encoding="utf-8") as f:
                        f.write(f"{api_key}\n")
                except Exception:
                    pass

            logger.info(f"🎉 SUCCESS! OpenRouter account {email} created with API key: {api_key[:12]}...")
            return True

    except GooglePhoneVerificationException:
        logger.error(f"Google phone verification triggered on {email}. Skipping.")
        store.upsert({"email": email, "status": FlowState.FAILED, "notes": "GOOGLE_PHONE_VERIFICATION"})
        results.mark_failed(email, "GOOGLE_PHONE_VERIFICATION")
        return False

    except Exception as e:
        err_msg = str(e)
        logger.error(f"FAILED for {email}: {err_msg}")
        store.upsert({"email": email, "status": FlowState.FAILED, "notes": err_msg[:120]})
        results.mark_failed(email, err_msg)
        return False

    finally:
        if active_browser:
            await safe_close_browser(active_browser)

# ── Main Orchestration / Worker Pool ───────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="OpenRouter Camoufox Runner")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed mode")
    parser.add_argument("--with-proxy", dest="use_proxy", action="store_true", default=True, help="Use proxies")
    parser.add_argument("--no-proxy", dest="use_proxy", action="store_false", help="Run directly without proxy")
    parser.add_argument("--proxy-file", type=str, default="", help="Custom proxy file")
    parser.add_argument("--delay", type=float, default=60.0, help="Delay between accounts in seconds")
    parser.add_argument("--state-file", type=str, default="state-openrouter.jsonl", help="Path to state JSONL")
    parser.add_argument("--limit", type=int, default=1, help="Max accounts to process")
    parser.add_argument("--domain", type=str, default="ifqy.net", help="TempMail domain")
    parser.add_argument("--pace", type=str, default="fast", choices=["fast", "human", "careful"])
    parser.add_argument("--auth", type=str, default="tempmail", choices=["tempmail", "google"], help="Auth method")
    parser.add_argument("--accounts-file", type=str, default="", help="Accounts file for Google OAuth (gsuite.txt)")
    parser.add_argument("--retry-failed", action="store_true", help="Retry failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Number of concurrent workers")
    parser.add_argument("--proxy-timeout", type=float, default=6.0, help="Proxy probe timeout")
    parser.add_argument("--skip-proxy-precheck", action="store_true", help="Skip HTTP 200 precheck")
    parser.add_argument("--reuse-proxy", action="store_true", help="Reuse proven good proxies")
    parser.add_argument("--password", type=str, default="torabikA1#", help="Default password")

    args = parser.parse_args()
    setup_process_signals()

    logger = create_logger("openrouter")
    state_file = args.state_file
    result_success_file = "akun-result-openrouter.txt"
    result_failed_file = "akun-failed-openrouter.txt"
    api_key_file = "apikey-openrouter.txt"

    store = JsonlStore(state_file)
    results = ResultWriter(result_success_file, result_failed_file, api_key_file)

    # Load proxies
    proxies: List[Proxy] = []
    if args.use_proxy:
        proxy_path = args.proxy_file or os.path.join(REPO_ROOT, "proxy-live.txt")
        if not os.path.exists(proxy_path):
            proxy_path = os.path.join(REPO_ROOT, "proxy.txt")
        if os.path.exists(proxy_path):
            proxies = load_proxies(proxy_path)
            logger.info(f"Loaded {len(proxies)} proxies for OpenRouter (reuse={args.reuse_proxy})")
        else:
            logger.warning(f"Proxy file not found at {proxy_path}. Running direct.")
            args.use_proxy = False

    proxy_pool = SmartProxyPool(proxies, reuse_proxy=args.reuse_proxy) if (args.use_proxy and proxies) else None

    # ── 1. Google OAuth Flow ────────────────────────────────────────────────
    if args.auth == "google":
        acc_file = args.accounts_file or os.path.join(REPO_ROOT, "gsuite.txt")
        if not os.path.exists(acc_file):
            logger.error(f"Accounts file {acc_file} not found for Google OAuth.")
            return

        all_accounts = load_accounts(acc_file)
        succeeded_emails = set(results.get_successful_emails())
        succeeded_emails.update(store.get_all_done_emails())
        failed_emails = set(results.get_failed_emails())
        failed_emails.update(store.get_all_failed_emails())

        todo_accounts: List[Account] = []
        for acc in all_accounts:
            norm = acc.email.strip().lower()
            if norm in succeeded_emails:
                continue
            if not args.retry_failed and norm in failed_emails:
                continue
            todo_accounts.append(acc)

        target_count = min(args.limit, len(todo_accounts)) if args.limit > 0 else len(todo_accounts)
        logger.info(f"Google OAuth mode: {len(todo_accounts)} eligible accounts, target={target_count}")

        if args.dry_run:
            logger.info("Dry-run validation complete. Exiting.")
            return

        account_queue = deque(todo_accounts)
        success_count = 0
        lock = asyncio.Lock()
        worker_count = max(1, min(args.workers, target_count or 1))

        async def google_worker(worker_id: int):
            nonlocal success_count
            while True:
                account = None
                proxy = None
                async with lock:
                    if success_count >= target_count or not account_queue:
                        break
                    account = account_queue.popleft()

                if args.use_proxy and proxy_pool:
                    proxy = await proxy_pool.get_next_live_proxy(
                        target_url=DEFAULT_SIGNUP_URL,
                        timeout_sec=args.proxy_timeout,
                        logger=logger,
                        enable_precheck=(not args.skip_proxy_precheck),
                    )
                    if proxy is None:
                        logger.warning(f"Worker #{worker_id}: Proxies exhausted.")
                        async with lock:
                            account_queue.appendleft(account)
                        break

                acc_logger = create_logger(f"w{worker_id}:{account.email}")
                logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")

                temp_mail = TempMailClient()
                ok = False
                try:
                    ok = await asyncio.wait_for(
                        run_openrouter_single(
                            account=account,
                            proxy=proxy,
                            store=store,
                            results=results,
                            args=args,
                            temp_mail=temp_mail,
                            logger=acc_logger,
                        ),
                        timeout=240.0,
                    )
                except asyncio.TimeoutError:
                    acc_logger.error(f"HARD TIMEOUT: Execution of {account.email} exceeded 240s.")
                    store.upsert({"email": account.email, "status": FlowState.FAILED, "notes": "HARD_TIMEOUT_240S"})
                    results.mark_failed(account.email, "HARD_TIMEOUT_240S")
                    ok = False
                except Exception as e:
                    acc_logger.error(f"Worker #{worker_id} error on {account.email}: {e}")
                    ok = False
                finally:
                    if worker_count == 1:
                        cleanup_leftover_browser_processes()
                        cleanup_temp_profiles()

                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, ok)

                if ok:
                    async with lock:
                        success_count += 1
                        logger.info(f"Worker #{worker_id} progress: {success_count}/{target_count} succeeded.")

                if success_count < target_count and args.delay > 0:
                    await asyncio.sleep(args.delay)

        await asyncio.gather(*(google_worker(i + 1) for i in range(worker_count)))
        logger.info(f"OpenRouter Google OAuth finished! Total succeeded: {success_count}/{target_count}")
        return

    # ── 2. TempMail Flow ────────────────────────────────────────────────────
    tempmail_domain = args.domain or "ifqy.net"
    if tempmail_domain.startswith("temp."):
        tempmail_domain = tempmail_domain[5:]
    if "://" in tempmail_domain:
        tempmail_domain = tempmail_domain.split("://")[1].split("/")[0]
        if tempmail_domain.startswith("temp."):
            tempmail_domain = tempmail_domain[5:]

    temp_mail_base_url = os.getenv("TEMPMAIL_BASE_URL", "https://temp-postservice.verifwebsitepro.workers.dev")
    temp_mail = TempMailClient(base_url=temp_mail_base_url, default_domain=tempmail_domain)

    count = args.limit if args.limit > 0 else (len(proxies) if proxies else 1)
    worker_count = max(1, min(args.workers, count))
    logger.info(f"TempMail mode: target={count} account(s) using domain @{tempmail_domain} with {worker_count} parallel worker(s)")

    if args.dry_run:
        logger.info("Dry-run validation complete. Exiting.")
        return

    processed = 0
    success_count = 0
    max_total_attempts = max(count * 4, len(proxies) * 2, 10) if proxies else count
    lock = asyncio.Lock()

    async def tempmail_worker(worker_id: int):
        nonlocal processed, success_count
        while True:
            proxy = None
            async with lock:
                if success_count >= count or processed >= max_total_attempts:
                    break
                processed += 1

            if args.use_proxy and proxy_pool:
                proxy = await proxy_pool.get_next_live_proxy(
                    target_url=DEFAULT_SIGNUP_URL,
                    timeout_sec=args.proxy_timeout,
                    logger=logger,
                    enable_precheck=(not args.skip_proxy_precheck),
                )
                if proxy is None:
                    logger.warning(f"Worker #{worker_id}: All proxies have been exhausted or blacklisted. No usable proxies left.")
                    break
                proxy_addr = proxy_pool.address_of(proxy)
                reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                logger.info(
                    f"Worker #{worker_id} selected verified proxy: {proxy.server} ({proxy_addr}){reuse_tag}. "
                    f"(Fresh remaining: {proxy_pool.fresh_count}, Good pool: {proxy_pool.good_count})"
                )

            # Dynamically create fresh TempMail account from API
            try:
                acc_data = await asyncio.to_thread(temp_mail.create_email, domain=tempmail_domain)
                email = acc_data["email"]
            except Exception as e:
                logger.error(f"Worker #{worker_id} failed to generate TempMail: {e}")
                await asyncio.sleep(2)
                continue

            password = args.password or "torabikA1#"
            acc_logger = create_logger(f"w{worker_id}:{email}")
            logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")

            ok = False
            try:
                ok = await asyncio.wait_for(
                    run_openrouter_single(
                        account=Account(email=email, password=password),
                        proxy=proxy,
                        store=store,
                        results=results,
                        args=args,
                        temp_mail=temp_mail,
                        logger=acc_logger,
                    ),
                    timeout=240.0,
                )
            except asyncio.TimeoutError:
                acc_logger.error(f"HARD TIMEOUT: Execution of {email} exceeded 240s.")
                store.upsert({"email": email, "status": FlowState.FAILED, "notes": "HARD_TIMEOUT_240S"})
                results.mark_failed(email, "HARD_TIMEOUT_240S")
                ok = False
            except Exception as e:
                acc_logger.error(f"Worker #{worker_id} error on {email}: {e}")
                ok = False
            finally:
                if worker_count == 1:
                    cleanup_leftover_browser_processes()
                    cleanup_temp_profiles()

            if proxy_pool and proxy:
                proxy_pool.mark_result(proxy, ok)

            if ok:
                async with lock:
                    success_count += 1
                    logger.info(f"Worker #{worker_id} progress: {success_count}/{count} succeeded.")

            if success_count < count and args.delay > 0:
                logger.info(f"Worker #{worker_id} waiting {args.delay}s before next account...")
                await asyncio.sleep(args.delay)

    await asyncio.gather(*(tempmail_worker(i + 1) for i in range(worker_count)))
    logger.info(f"OpenRouter TempMail finished! Total succeeded: {success_count}/{count}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[OpenRouter] Terminated by user.")
        cleanup_leftover_browser_processes()
        cleanup_temp_profiles()
        sys.exit(130)
