#!/usr/bin/env python3
"""
Zro MoonMath Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on Zro MoonMath (zro.moonmath.ai) using either TempMail-Pro (with OTP)
or Google OAuth (GSuite), handles Clerk authentication & Cloudflare Turnstile,
completes legal terms consent, creates API keys, and saves tokens to apikey-zro.txt
and akun-result-zro.txt.

Guarantees:
- Strict HTTP 200 pre-check against target web (https://zro.moonmath.ai/sign-up) before execution.
- Unique randomized browser fingerprint per account (OS rotation, window jitter, hardware cores, UA).
"""

from __future__ import annotations
import argparse
import asyncio
from collections import deque
import concurrent.futures
import json
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Tuple, Union, Dict, Any
from urllib.parse import urlparse
import requests
import urllib3

# Suppress insecure request warnings during proxy pre-check
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

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

class FlowState(FlowState):
    OTP_SENT = "OTP_SENT"
    EMAIL_VERIFIED = "EMAIL_VERIFIED"
    LEGAL_ACCEPTED = "LEGAL_ACCEPTED"
    OVERVIEW = "OVERVIEW"

API_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b")
OTP_CODE_RE = re.compile(r"\b\d{6}\b")

DEFAULT_SIGNUP_URL = "https://zro.moonmath.ai/sign-up"
VERIFY_EMAIL_URL = "https://zro.moonmath.ai/sign-up/create/verify-email-address"
LEGAL_CONSENT_URL = "https://zro.moonmath.ai/sign-up/create/continue"
DASHBOARD_URL = "https://zro.moonmath.ai/overview"
API_KEYS_URL = "https://zro.moonmath.ai/api-keys"

DIVERSE_OS_LIST = ["windows", "macos", "linux"]
POPULAR_RESOLUTIONS = [
    (1920, 1080),
    (1536, 864),
    (1440, 900),
    (1366, 768),
    (1280, 800),
    (1600, 900),
    (1680, 1050),
]
_account_launch_counter = 0


def get_unique_account_fingerprint() -> Dict[str, Any]:
    """Generates unique OS, window dimension, and humanize parameters for each account."""
    global _account_launch_counter
    _account_launch_counter += 1
    # Rotate OS: Windows -> MacOS -> Linux
    target_os = DIVERSE_OS_LIST[_account_launch_counter % len(DIVERSE_OS_LIST)]
    base_w, base_h = random.choice(POPULAR_RESOLUTIONS)
    jitter_w = max(1024, base_w - random.randint(0, 120))
    jitter_h = max(700, base_h - random.randint(30, 120))
    humanize_speed = round(random.uniform(0.75, 1.65), 2)
    return {
        "os": target_os,
        "window": (jitter_w, jitter_h),
        "humanize": humanize_speed,
    }


def extract_proxy_address(proxy_str: str) -> str:
    try:
        u = proxy_str if "://" in proxy_str else f"http://{proxy_str}"
        return urlparse(u).hostname or proxy_str
    except Exception:
        return proxy_str


class SmartProxyPool:
    """Smart proxy manager with live pre-check and blacklist."""

    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies = deque(proxies)
        self.good_proxies = deque()
        self.bad_addresses: Set[str] = set()
        self.reuse_proxy = reuse_proxy

    @property
    def fresh_count(self) -> int:
        return len(self.fresh_proxies)

    @property
    def good_count(self) -> int:
        return len(self.good_proxies)

    @property
    def has_proxies(self) -> bool:
        return len(self.fresh_proxies) > 0 or len(self.good_proxies) > 0

    def mark_result(self, proxy: Proxy, success: bool):
        if not proxy:
            return
        addr = extract_proxy_address(proxy.server)
        if success:
            if proxy not in self.good_proxies:
                self.good_proxies.append(proxy)
        else:
            self.bad_addresses.add(addr)
            self.good_proxies = deque([p for p in self.good_proxies if extract_proxy_address(p.server) != addr])

    def get_next_proxy(self) -> Optional[Proxy]:
        if self.reuse_proxy and self.good_proxies:
            p = self.good_proxies.popleft()
            self.good_proxies.append(p)
            return p

        while self.fresh_proxies:
            p = self.fresh_proxies.popleft()
            addr = extract_proxy_address(p.server)
            if addr not in self.bad_addresses:
                return p

        if self.good_proxies:
            p = self.good_proxies.popleft()
            self.good_proxies.append(p)
            return p

        return None


async def get_next_live_proxy(
    pool: SmartProxyPool,
    target_url: str = DEFAULT_SIGNUP_URL,
    timeout_sec: float = 6.0,
    batch_size: int = 15,
    logger=None,
) -> Optional[Proxy]:
    """Pre-checks candidate proxies in parallel and strictly ensures HTTP status is 200 before execution."""
    if pool.reuse_proxy and pool.good_proxies:
        p = pool.good_proxies.popleft()
        pool.good_proxies.append(p)
        return p

    while True:
        if pool.good_proxies:
            p = pool.good_proxies.popleft()
            if pool.reuse_proxy:
                pool.good_proxies.append(p)
            return p

        candidates: List[Proxy] = []
        while pool.fresh_proxies and len(candidates) < batch_size:
            p = pool.fresh_proxies.popleft()
            addr = extract_proxy_address(p.server)
            if addr not in pool.bad_addresses:
                candidates.append(p)

        if not candidates:
            if pool.good_proxies:
                p = pool.good_proxies.popleft()
                if pool.reuse_proxy:
                    pool.good_proxies.append(p)
                return p
            return None

        if logger:
            logger.info(
                f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against target ({target_url}, strict HTTP 200, timeout={timeout_sec}s)... "
                f"(Fresh: {pool.fresh_count}, Good pool: {pool.good_count})"
            )

        loop = asyncio.get_event_loop()

        def check_one(proxy: Proxy) -> Tuple[Proxy, bool, str, float]:
            t0 = time.time()
            server_str = proxy.server
            if proxy.username and proxy.password and "@" not in server_str:
                u = urlparse(server_str)
                scheme = u.scheme or "http"
                netloc = u.netloc or server_str.replace(f"{scheme}://", "")
                server_str = f"{scheme}://{proxy.username}:{proxy.password}@{netloc}"

            proxies_dict = {
                "http": server_str,
                "https": server_str,
            }
            try:
                resp = requests.get(
                    target_url,
                    proxies=proxies_dict,
                    timeout=timeout_sec,
                    verify=False,
                    allow_redirects=True,
                    headers={
                        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    },
                )
                dt = round(time.time() - t0, 2)
                # Strict HTTP 200 verification
                ok = (resp.status_code == 200)
                status_desc = f"HTTP {resp.status_code}" if ok else f"HTTP {resp.status_code} (non-200)"
                return proxy, ok, status_desc, dt
            except Exception as e:
                dt = round(time.time() - t0, 2)
                return proxy, False, type(e).__name__, dt

        with concurrent.futures.ThreadPoolExecutor(max_workers=batch_size) as executor:
            tasks = [loop.run_in_executor(executor, check_one, c) for c in candidates]
            results = await asyncio.gather(*tasks)

        good_in_batch: List[Proxy] = []
        bad_count = 0
        for p, ok, status, dt in results:
            addr = extract_proxy_address(p.server)
            if ok:
                good_in_batch.append(p)
                if logger:
                    logger.info(f"✅ Proxy pre-check PASSED: {p.server} ({addr}) -> HTTP 200 in {dt}s")
            else:
                pool.bad_addresses.add(addr)
                bad_count += 1
                if logger:
                    logger.info(f"❌ Proxy pre-check REJECTED: {p.server} ({addr}) -> {status} in {dt}s")

        if bad_count > 0 and logger:
            logger.info(f"⏭️ Discarded {bad_count} non-200 / unresponsive proxies from batch.")

        if good_in_batch:
            chosen = good_in_batch[0]
            for extra in good_in_batch[1:]:
                if extra not in pool.good_proxies:
                    pool.good_proxies.append(extra)
            return chosen


async def handle_legal_consent_if_present(page, logger) -> bool:
    """Checks for the Terms of Service & Privacy Policy agreement screen, checks the checkbox, and accepts it."""
    cur_url = page.url or ""
    if "/overview" in cur_url or "/api-keys" in cur_url:
        return True

    try:
        checkbox = page.locator('input#legalAccepted-field, input[name="legalAccepted"], input[type="checkbox"]')
        lbl = page.locator('label[for="legalAccepted-field"], .cl-formFieldCheckboxLabel')
        if "/continue" in cur_url or await checkbox.count() > 0 or await lbl.count() > 0:
            logger.info("found legal consent screen. Checking Terms of Service checkbox...")
            
            # 1. Wait for checkbox / label to mount
            try:
                await page.wait_for_selector('input#legalAccepted-field, label[for="legalAccepted-field"], .cl-formFieldCheckboxLabel', timeout=15000)
            except Exception:
                pass

            # 2. Try clicking label or checkbox with retry loop until checked is confirmed
            is_checked = False
            for attempt in range(6):
                # Click label
                if await lbl.count() > 0:
                    try:
                        await lbl.first.click(timeout=5000)
                    except Exception:
                        pass
                else:
                    try:
                        await checkbox.first.click(force=True, timeout=5000)
                    except Exception:
                        pass
                await asyncio.sleep(0.3)

                # Check via DOM
                is_checked = await page.evaluate("""() => {
                    const cb = document.querySelector('input#legalAccepted-field, input[name="legalAccepted"]');
                    if (cb && !cb.checked) {
                        cb.click();
                        if (!cb.checked) {
                            const proto = window.HTMLInputElement.prototype;
                            const nativeSet = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
                            if (nativeSet) nativeSet.call(cb, true);
                            else cb.checked = true;
                            cb.dispatchEvent(new Event('input', { bubbles: true }));
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    return cb ? Boolean(cb.checked) : false;
                }""")
                logger.info(f"legal consent checkbox state (attempt {attempt + 1}): checked={is_checked}")
                if is_checked:
                    break
                await asyncio.sleep(0.4)

            if not is_checked:
                logger.warning("Could not confirm checkbox is checked! Forcing DOM click...")
                await page.evaluate("() => { const cb = document.querySelector('input#legalAccepted-field'); if (cb) cb.click(); }")
                await asyncio.sleep(0.5)
                is_checked = await page.evaluate("() => { const cb = document.querySelector('input#legalAccepted-field'); return cb ? Boolean(cb.checked) : false; }")

            await human_delay(500, 800)

            # 3. ONLY Click 'Continue with email' button if checkbox is confirmed checked
            if not is_checked:
                logger.error("❌ Checkbox is not checked! Refusing to click Continue to prevent browser validation error.")
                return False

            cont_btn = page.locator('button.cl-formButtonPrimary, button:has-text("Continue with email")')
            if await cont_btn.count() > 0:
                logger.info("checkbox confirmed checked! Clicking 'Continue with email'...")
                await cont_btn.first.click()
                await human_delay(2000, 3500)

            # 4. Wait for redirect away from /continue
            redirect_deadline = time.time() + 15
            while time.time() < redirect_deadline:
                cur_u = page.url or ""
                if "/continue" not in cur_u:
                    logger.info(f"redirected away from legal consent: {cur_u}")
                    return True
                # If still on /continue, check if validation stopped submit
                still_checked = await page.evaluate("() => { const cb = document.querySelector('input#legalAccepted-field'); return cb ? Boolean(cb.checked) : false; }")
                if not still_checked:
                    logger.info("re-checking legal consent checkbox...")
                    if await lbl.count() > 0:
                        await lbl.first.click()
                    await asyncio.sleep(0.4)
                    if await cont_btn.count() > 0:
                        await cont_btn.first.click()
                await asyncio.sleep(1)

            return True
    except Exception as e:
        logger.warning(f"legal consent check: {e}")
    return False


async def create_and_extract_api_key(
    page,
    email: str,
    screenshot_dir: str,
    logger,
) -> str:
    """Navigates to Dashboard (/overview), then to API keys (/api-keys), creates an API key with random alias, and extracts the sk-... key."""
    # Ensure legal consent is completed if redirected
    await handle_legal_consent_if_present(page, logger)

    # 1. First navigate to Dashboard (/overview) as requested by user to avoid getting stuck on /get-started
    logger.info(f"navigating to Dashboard (overview): {DASHBOARD_URL} (avoiding /get-started trap)...")
    try:
        await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=35000)
        await human_delay(2000, 3000)
    except Exception as e:
        logger.warning(f"Dashboard navigation error: {e}")

    # Re-check legal consent if redirected back to /continue
    if "/continue" in (page.url or ""):
        await handle_legal_consent_if_present(page, logger)
        await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=35000)
        await human_delay(2000, 3000)

    # If stuck on /get-started, try clicking Account or sidebar to break out
    cur_u = page.url or ""
    if "/get-started" in cur_u:
        logger.info("currently on /get-started. Attempting to navigate out via sidebar or Account button...")
        nav_btn = page.locator('button.account-side-button:has-text("Overview"), button.account-side-button:has-text("API Keys"), a[href*="/overview"], a[href*="/api-keys"], button:has-text("Account")')
        if await nav_btn.count() > 0:
            await nav_btn.first.click()
            await human_delay(2000, 3000)

    # 2. Then navigate to API Keys page
    logger.info(f"navigating to Zro MoonMath API keys page: {API_KEYS_URL}")
    await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
    await human_delay(2000, 3000)

    # In case redirected to continue / consent
    if "/continue" in (page.url or ""):
        await handle_legal_consent_if_present(page, logger)
        await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
        await human_delay(2000, 3000)

    # If still on /get-started, try clicking sidebar 'API Keys'
    if "/api-keys" not in (page.url or ""):
        side_apikey = page.locator('button.account-side-button:has-text("API Keys"), a[href*="/api-keys"]')
        if await side_apikey.count() > 0:
            logger.info("clicking sidebar 'API Keys' button...")
            await side_apikey.first.click()
            await human_delay(2000, 3000)
        else:
            await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
            await human_delay(2000, 3000)

    # Clipboard capture hook as backup
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

    # Look for 'Create key' button
    logger.info("waiting for 'Create key' button...")
    create_btn = page.locator('button.bg-ink:has-text("Create key"), button:has-text("Create key")')
    await create_btn.first.wait_for(state="visible", timeout=25000)
    await create_btn.first.click()
    await human_delay(1500, 2500)

    # Modal appears: fill API key alias
    random_alias = f"agent-prod-{random.randint(1000, 9999)}"
    logger.info(f"filling API key alias: {random_alias}")
    alias_input = page.locator('input#api-key-alias, input[placeholder="agent-prod"]')
    await alias_input.first.wait_for(state="visible", timeout=15000)
    await human_type(page, 'input#api-key-alias, input[placeholder="agent-prod"]', random_alias)
    await human_delay(600, 1000)

    # Submit modal: 'Create' button
    logger.info("submitting API key creation modal...")
    submit_btn = page.locator('button[type="submit"]:has-text("Create"), button:has-text("Create")')
    await submit_btn.first.wait_for(state="visible", timeout=10000)
    await submit_btn.first.click()
    await human_delay(2000, 3500)

    # Wait for key in success view (apikey-success.html)
    logger.info("waiting for API key to appear in success view...")
    code_locator = page.locator('code.text-ink, code:has-text("sk-"), code')
    try:
        await code_locator.first.wait_for(state="visible", timeout=25000)
    except Exception:
        pass

    # Extract key from DOM or clipboard
    extracted_key: Optional[str] = None

    # 1. From code elements
    for i in range(await code_locator.count()):
        txt = (await code_locator.nth(i).text_content() or "").strip()
        m = API_KEY_RE.search(txt)
        if m:
            extracted_key = m.group(0)
            break

    # 2. From page text if not found yet
    if not extracted_key:
        body_text = await page.inner_text("body")
        m = API_KEY_RE.search(body_text)
        if m:
            extracted_key = m.group(0)

    # 3. Try clicking "Copy key" and inspect clipboard
    if not extracted_key:
        copy_btn = page.locator('button:has-text("Copy key"), button:has-text("Copy")')
        if await copy_btn.count() > 0:
            await copy_btn.first.click()
            await human_delay(500, 1000)
            cb_val = await page.evaluate("() => window.__copied_key || null")
            if cb_val and API_KEY_RE.search(cb_val):
                extracted_key = API_KEY_RE.search(cb_val).group(0)

    if not extracted_key:
        # Take diagnostic screenshot
        sc_path = os.path.join(screenshot_dir, f"apikey_fail_{int(time.time())}.png")
        await page.screenshot(path=sc_path, full_page=True)
        raise RuntimeError(f"Could not extract Zro MoonMath API key (screenshot saved to {sc_path})")

    logger.info(f"successfully extracted API key: {extracted_key[:10]}...")

    # Dismiss dialog with 'Done' button if visible
    try:
        done_btn = page.locator('button:has-text("Done")')
        if await done_btn.count() > 0 and await done_btn.first.is_visible():
            await done_btn.first.click()
            await human_delay(400, 800)
    except Exception:
        pass

    return extracted_key


async def run_zro_single(
    account: Optional[Account],
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    args: argparse.Namespace,
    temp_mail: TempMailClient,
    logger,
) -> bool:
    """Executes single Zro MoonMath account creation via Camoufox."""
    auth_method = args.auth or "tempmail"
    email = account.email if account else None
    password = account.password if (account and account.password) else (args.password or "torabikA1###########")
    screenshot_dir = os.path.join(REPO_ROOT, "artifacts", "screenshots", "zromoonmath")
    os.makedirs(screenshot_dir, exist_ok=True)

    # Safeguard: skip if already completed
    if email:
        norm_email = email.strip().lower()
        if norm_email in results.get_successful_emails() or store.is_done(norm_email):
            logger.info(f"safeguard: email {email} already completed. Skipping.")
            return True

    # In TempMail mode: generate fresh email address
    if auth_method == "tempmail" and not email:
        domain = args.domain or "ifqy.net"
        if domain.startswith("temp."):
            domain = domain[5:]
        logger.info(f"creating TempMail address using domain @{domain}...")
        created = await asyncio.to_thread(temp_mail.create_email, domain=domain)
        email = created["email"]

    if not email:
        raise ValueError("No email available for Zro MoonMath registration")

    store.upsert({"email": email, "password": password, "status": FlowState.PENDING})

    active_browser = None
    page = None
    context = None
    try:
        # Generate unique per-account fingerprint
        fp_options = get_unique_account_fingerprint()
        logger.info(
            f"🎭 Generated unique fingerprint for {email}: OS={fp_options['os']}, "
            f"Window={fp_options['window'][0]}x{fp_options['window'][1]}, Humanize={fp_options['humanize']}"
        )

        logger.info(
            f"starting Zro MoonMath ({auth_method}) registration for {email} "
            f"(verified_proxy={proxy.server if proxy else 'direct'}, pace={args.pace})"
        )
        browser_ctx = await launch_camoufox(
            headless=not args.headed,
            proxy=proxy,
            geoip=True,
            **fp_options,
        )

        async with browser_ctx as browser:
            active_browser = browser
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            fp_info = await get_browser_fingerprint_info(page)
            if fp_info:
                gpu_tag = f" | GPU={fp_info.get('renderer')[:35]}" if fp_info.get('renderer') and fp_info.get('renderer') != 'unknown' else ""
                logger.info(
                    f"🛡️ Camoufox Active Fingerprint: OS={fp_info.get('platform')} | Screen={fp_info.get('screen')} | "
                    f"Viewport={fp_info.get('viewport')} | Cores={fp_info.get('cores')}{gpu_tag} | UA={fp_info.get('ua')}"
                )

            # ── Mode A: Google OAuth ───────────────────────────────────────────
            if auth_method == "google":
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
                await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=45000)
                await human_delay(1500, 2500)

                # Wait for Google OAuth button in Clerk card
                logger.info("waiting for Google OAuth button in Clerk signup card...")
                google_btn = page.locator(
                    'button.cl-socialButtonsBlockButton__google, button:has-text("Continue with Google"), button[data-provider="google"]'
                )
                try:
                    await google_btn.first.wait_for(state="visible", timeout=25000)
                except Exception:
                    if "/sign-up" not in (page.url or ""):
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

                # Wait for redirect back to Zro MoonMath
                logger.info("waiting for OAuth redirect back to Zro MoonMath...")
                redirect_deadline = time.time() + 45
                while time.time() < redirect_deadline:
                    cur_url = page.url or ""
                    if "zro.moonmath.ai" in cur_url and "accounts.google.com" not in cur_url:
                        break
                    await asyncio.sleep(1)

                # Solve Turnstile if present
                await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                # Check and accept legal consent
                await handle_legal_consent_if_present(page, logger)

            # ── Mode B: TempMail direct signup + OTP ──────────────────────────
            else:
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
                await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=45000)
                await human_delay(1500, 2500)

                # Check if already logged in
                if "/overview" in (page.url or "") or "/api-keys" in (page.url or ""):
                    logger.info("already logged in, proceeding to API keys.")
                else:
                    # Fill email identifier in Clerk signup card
                    logger.info("waiting for email identifier input...")
                    email_input = page.locator('input#identifier-field, input[name="identifier"], input[placeholder*="email" i]')
                    try:
                        await email_input.first.wait_for(state="visible", timeout=30000)
                    except Exception:
                        if "/sign-up" not in (page.url or ""):
                            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=35000)
                        await email_input.first.wait_for(state="visible", timeout=25000)

                    logger.info(f"typing email into Clerk identifier: {email}")
                    await human_type(page, 'input#identifier-field, input[name="identifier"]', email)
                    await human_delay(400, 700)

                    # Solve Turnstile if present before submit
                    await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                    # Click Continue with email
                    logger.info("submitting Clerk email form...")
                    submit_btn = page.locator('button.cl-formButtonPrimary, button:has-text("Continue with email"), button:has-text("Continue")')
                    await submit_btn.first.wait_for(state="visible", timeout=10000)
                    await submit_btn.first.click()
                    await human_delay(2500, 4000)

                    # Solve Turnstile after submit if challenged
                    await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                    # Wait for OTP input to mount
                    store.upsert({"email": email, "status": FlowState.OTP_SENT})
                    logger.info("waiting for OTP verification screen...")
                    otp_input = page.locator('input[data-input-otp="true"], input[aria-label="Enter verification code"]')
                    await otp_input.first.wait_for(state="visible", timeout=35000)

                    # Poll TempMail inbox for 6-digit OTP code
                    logger.info(f"polling TempMail inbox for Zro verification OTP code on {email}...")
                    otp_code = await temp_mail.wait_for_verification_otp(
                        address=email,
                        timeout_sec=120,
                        interval_sec=3.0,
                        filter_sender="zro",
                        logger=logger,
                    )
                    logger.info(f"received verification OTP code: {otp_code}!")
                    store.upsert({"email": email, "status": FlowState.EMAIL_VERIFIED, "otpCode": otp_code})

                    # Type OTP digits into input[data-input-otp="true"]
                    await otp_input.first.click()
                    await human_delay(200, 400)
                    try:
                        await otp_input.first.press_sequentially(otp_code, delay=100)
                    except Exception:
                        await human_type(page, 'input[data-input-otp="true"], input[aria-label="Enter verification code"]', otp_code)
                    
                    logger.info("OTP typed. Clerk auto-submits upon 6 digits. Waiting for transition to Legal Consent (/continue)...")

                    # Turnstile check
                    await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                    # ── Handle Legal Consent (/sign-up/create/continue) ────────
                    store.upsert({"email": email, "status": FlowState.LEGAL_ACCEPTED})
                    consent_deadline = time.time() + 45
                    while time.time() < consent_deadline:
                        cur_u = page.url or ""
                        has_legal = "/continue" in cur_u or await page.locator('input#legalAccepted-field, label[for="legalAccepted-field"]').count() > 0
                        if has_legal:
                            logger.info(f"Legal consent screen reached! (url={cur_u})")
                            await handle_legal_consent_if_present(page, logger)
                        if "/overview" in cur_u or "/api-keys" in cur_u or "/get-started" in cur_u:
                            logger.info(f"moved past signup/legal consent to: {cur_u}")
                            break
                        await asyncio.sleep(1)

            # ── Create API Key ───────────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(
                page=page,
                email=email,
                screenshot_dir=screenshot_dir,
                logger=logger,
            )

            # ── Mark Done & Save Results ─────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.DONE, "apiKey": api_key})
            results.mark_success(email, password, api_key)

            # Also write key to apikey-zro.txt in root and dataset if present
            root_key_file = os.path.join(REPO_ROOT, "apikey-zro.txt")
            try:
                with open(root_key_file, "a", encoding="utf-8") as f:
                    f.write(f"{api_key}\n")
            except Exception:
                pass

            dataset_key_file = os.path.join(REPO_ROOT, "zromoonshotai-dataset", "apikey-zro.txt")
            if os.path.isdir(os.path.dirname(dataset_key_file)):
                try:
                    with open(dataset_key_file, "a", encoding="utf-8") as f:
                        f.write(f"{api_key}\n")
                except Exception:
                    pass

            logger.info(f"🎉 SUCCESS! Zro MoonMath account {email} created with API key: {api_key[:12]}...")
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
        # Explicit Page and Context closure (SKILL Rule 8)
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
        if active_browser:
            await safe_close_browser(active_browser)


# ── Main Orchestration / Worker Pool ───────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Zro MoonMath Camoufox Runner")
    parser.add_argument("--headed", action="store_true", help="Launch browser with GUI visible")
    parser.add_argument("--use-proxy", action="store_true", default=True, help="Route requests through proxy")
    parser.add_argument("--no-proxy", action="store_false", dest="use_proxy", help="Disable proxy usage")
    parser.add_argument("--proxy-file", type=str, default="proxy-live.txt", help="Path to proxy list")
    parser.add_argument("--delay-sec", type=int, default=2, help="Delay between account creations")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--state-file", type=str, default="state-zro.jsonl", help="Path to state JSONL")
    parser.add_argument("--limit", "-l", "-n", type=int, default=0, help="Maximum successful accounts to generate")
    parser.add_argument("--domain", "-d", type=str, default="ifqy.net", help="TempMail domain (default: ifqy.net)")
    parser.add_argument("--pace", type=str, default="human", choices=["fast", "human", "careful"], help="Typing cadence")
    parser.add_argument("--auth", type=str, default="tempmail", choices=["tempmail", "google"], help="Authentication mode")
    parser.add_argument("--accounts-file", "-f", type=str, help="Accounts file for Google OAuth (default: gsuite.txt)")
    parser.add_argument("--password", "-p", type=str, default="torabikA1###########", help="Default password for accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Number of concurrent workers")

    args = parser.parse_args()

    setup_process_signals()
    logger = create_logger("zromoonmath")

    result_success_file = "akun-result-zro.txt"
    result_failed_file = "akun-failed-zro.txt"
    api_key_file = "apikey-zro.txt"

    store = JsonlStore(args.state_file)
    results = ResultWriter(result_success_file, result_failed_file, api_key_file)

    temp_mail_api_key = os.getenv("TEMPMAIL_API_KEY", "anjingmemekkontol")
    temp_mail_base_url = os.getenv("TEMPMAIL_BASE_URL", "https://temp-postservice.verifwebsitepro.workers.dev")
    clean_domain = args.domain[5:] if args.domain.startswith("temp.") else args.domain
    temp_mail = TempMailClient(api_key=temp_mail_api_key, base_url=temp_mail_base_url, default_domain=clean_domain)

    # Resolve proxies
    proxy_path = args.proxy_file
    if not os.path.exists(proxy_path) and os.path.exists("proxy.txt"):
        proxy_path = "proxy.txt"
    raw_proxies = load_proxies(proxy_path) if args.use_proxy else []
    proxy_pool = SmartProxyPool(raw_proxies, reuse_proxy=False) if raw_proxies else None

    # Resolve accounts for Google OAuth
    accounts: List[Account] = []
    if args.auth == "google":
        acc_file = args.accounts_file
        if not acc_file:
            if os.path.exists("zromoonshotai-dataset/gsuite.txt"):
                acc_file = "zromoonshotai-dataset/gsuite.txt"
            elif os.path.exists("gsuite.txt"):
                acc_file = "gsuite.txt"
        if acc_file and os.path.exists(acc_file):
            accounts = load_accounts(acc_file)
        else:
            logger.error(f"Google OAuth requested but no accounts file found (checked {acc_file})")
            sys.exit(1)

    logger.info(
        f"Zro MoonMath runner initialized: auth={args.auth}, workers={args.workers}, limit={args.limit}, "
        f"proxies={len(raw_proxies)}, accounts={len(accounts)}, headless={not args.headed}"
    )

    if args.dry_run:
        logger.info("Dry run complete. Exiting.")
        return

    # Filter accounts
    if args.auth == "google":
        successful_emails = results.get_successful_emails()
        failed_emails = results.get_failed_emails()
        todo_accounts = [
            acc for acc in accounts
            if acc.email.strip().lower() not in successful_emails
            and (args.retry_failed or acc.email.strip().lower() not in failed_emails)
        ]
        target_count = min(args.limit, len(todo_accounts)) if args.limit > 0 else len(todo_accounts)
        logger.info(f"Google accounts to process: {len(todo_accounts)} (target: {target_count})")
        account_queue = deque(todo_accounts)
    else:
        target_count = args.limit if args.limit > 0 else (len(raw_proxies) if raw_proxies else 1)
        logger.info(f"TempMail accounts target: {target_count}")
        account_queue = deque()

    success_count = 0
    lock = asyncio.Lock()

    async def worker(worker_id: int):
        nonlocal success_count
        while True:
            async with lock:
                if success_count >= target_count:
                    break

            acc: Optional[Account] = None
            if args.auth == "google":
                async with lock:
                    if not account_queue:
                        break
                    acc = account_queue.popleft()

            # Select and strictly pre-check proxy against target URL for HTTP 200
            proxy: Optional[Proxy] = None
            if proxy_pool:
                proxy = await get_next_live_proxy(
                    proxy_pool,
                    target_url=DEFAULT_SIGNUP_URL,
                    timeout_sec=6.0,
                    batch_size=15,
                    logger=logger,
                )
                if not proxy:
                    logger.warning(f"worker #{worker_id}: all proxies have been exhausted or blacklisted (no HTTP 200 proxy found).")
                    if acc:
                        async with lock:
                            account_queue.appendleft(acc)
                    break
                logger.info(f"worker #{worker_id} assigned verified HTTP 200 proxy: {proxy.server} (fresh: {proxy_pool.fresh_count}, good: {proxy_pool.good_count})")

            ok = await run_zro_single(
                account=acc,
                proxy=proxy,
                store=store,
                results=results,
                args=args,
                temp_mail=temp_mail,
                logger=logger,
            )

            if proxy_pool and proxy:
                proxy_pool.mark_result(proxy, ok)

            if ok:
                async with lock:
                    success_count += 1
                    logger.info(f"Progress: {success_count}/{target_count} Zro MoonMath accounts created.")
            elif acc and proxy_pool and proxy_pool.has_proxies:
                async with lock:
                    if success_count < target_count:
                        account_queue.append(acc)

            if success_count < target_count and args.delay_sec > 0:
                await asyncio.sleep(args.delay_sec)

    worker_count = min(args.workers, target_count if target_count > 0 else 1)
    logger.info(f"Launching {worker_count} worker(s)...")
    tasks = [worker(i + 1) for i in range(worker_count)]
    await asyncio.gather(*tasks)

    logger.info(f"All done! Total accounts succeeded: {success_count}/{target_count}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[!] Execution interrupted by user. Cleaning up...")
        cleanup_leftover_browser_processes()
        sys.exit(0)
