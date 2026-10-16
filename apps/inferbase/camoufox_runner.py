#!/usr/bin/env python3
"""
Inferbase Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on Inferbase using either TempMail-Pro or Google OAuth (GSuite),
handles Cloudflare Turnstile, completes onboarding, generates API keys, and saves tokens.
"""

from __future__ import annotations
import argparse
import asyncio
from collections import deque
import concurrent.futures
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
    TempMailClient,
    resolve_turnstile_if_present,
    dismiss_turnstile_modal,
    perform_google_oauth,
    GooglePhoneVerificationException,
)
from packages.camoufox_core.turnstile import find_turnstile_target

API_KEY_RE = re.compile(r"\binf_[A-Za-z0-9_\-]{20,}\b")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?inferbase\.ai/verify-email\?token=[A-Za-z0-9_\-\.]+", re.IGNORECASE)

DEFAULT_SIGNUP_URL = "https://inferbase.ai/register"
ONBOARDING_URL = "https://inferbase.ai/onboarding"
DASHBOARD_URL = "https://inferbase.ai/dashboard"
API_KEYS_URL = "https://inferbase.ai/api-keys"

FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Chris", "Pat", "Riley", "Casey", "Avery", "Jamie", "Logan"]
LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Taylor", "Anderson"]
COMPANIES = ["Acme AI", "TechVentures", "DataFlow Inc", "CloudScale", "Nexus Labs", "Cognitive Systems", "AlphaByte"]

def generate_random_name() -> str:
    return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"

def generate_random_company() -> str:
    return random.choice(COMPANIES)

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
    """
    Probes candidate proxy by performing a synchronous HTTP GET to target_url.
    Returns (proxy, is_ok, status_or_reason, latency_seconds).
    is_ok is True ONLY if the server returns HTTP 200.
    """
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
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        resp = requests.get(
            target_url,
            proxies=proxies,
            headers=headers,
            timeout=timeout_sec,
            allow_redirects=True,
        )
        elapsed = round(time.time() - t0, 2)
        if resp.status_code == 200:
            return proxy, True, 200, elapsed
        return proxy, False, f"HTTP_{resp.status_code}", elapsed
    except requests.exceptions.ConnectTimeout:
        return proxy, False, "connect_timeout", round(time.time() - t0, 2)
    except requests.exceptions.ReadTimeout:
        return proxy, False, "read_timeout", round(time.time() - t0, 2)
    except requests.exceptions.Timeout:
        return proxy, False, "timeout", round(time.time() - t0, 2)
    except requests.exceptions.ProxyError:
        return proxy, False, "proxy_error", round(time.time() - t0, 2)
    except requests.exceptions.SSLError:
        return proxy, False, "ssl_error", round(time.time() - t0, 2)
    except requests.exceptions.ConnectionError:
        return proxy, False, "connection_refused", round(time.time() - t0, 2)
    except Exception as e:
        return proxy, False, type(e).__name__, round(time.time() - t0, 2)


def check_proxy_batch_sync(
    candidates: List[Proxy],
    target_url: str = DEFAULT_SIGNUP_URL,
    timeout_sec: float = 6.0,
    max_workers: int = 15,
) -> List[Tuple[Proxy, bool, Union[int, str], float]]:
    workers = min(max_workers, max(1, len(candidates)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(check_proxy_single_sync, p, target_url, timeout_sec) for p in candidates]
        return [f.result() for f in futures]


class SmartProxyPool:
    """Manages proxy allocation with intelligent failure handling and success reuse.
    - Bad/rejected proxies are permanently discarded.
    - Successful proxies are preserved in a reusable pool and recycled when fresh proxies run out.
    - Proactively probes candidate proxies against Inferbase before opening the browser.
      Any proxy that times out or returns non-200 is skipped immediately without launching Camoufox.
    """
    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies: deque[Proxy] = deque(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: Set[str] = set()
        self.reuse_proxy = reuse_proxy
        self.lock = asyncio.Lock()

    @staticmethod
    def address_of(proxy: Proxy) -> str:
        try:
            return urlparse(proxy.server).hostname or proxy.server
        except Exception:
            return proxy.server

    def get_next_proxy(self) -> Optional[Proxy]:
        """Synchronous retrieval without pre-check (for backwards compatibility)."""
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
        """
        Asynchronously retrieves the next proxy that is guaranteed to return HTTP 200 on Inferbase.
        Candidate fresh proxies are tested concurrently in batches of `batch_size`.
        Any proxy that times out or returns non-200 is immediately skipped and discarded.
        """
        if not enable_precheck:
            async with self.lock:
                return self.get_next_proxy()

        # 1. If reuse_proxy is active and we have proven good proxies, reuse good proxy immediately
        async with self.lock:
            if self.reuse_proxy and self.good_proxies:
                p = self.good_proxies.pop(0)
                self.good_proxies.append(p)
                return p

        # 2. Loop through fresh proxies in parallel batches until an HTTP 200 proxy is found
        while True:
            candidates: List[Proxy] = []
            async with self.lock:
                # If good_proxies has accumulated candidates from other batch probes, consume them
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
                    # Fresh proxies exhausted
                    if self.good_proxies:
                        p = self.good_proxies.pop(0)
                        if self.reuse_proxy:
                            self.good_proxies.append(p)
                        return p
                    return None

            # Probe the candidate batch concurrently
            if logger:
                logger.info(
                    f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against Inferbase (HTTP 200, timeout={timeout_sec}s)... "
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
            self.fresh_proxies = deque([p for p in self.fresh_proxies if self.address_of(p) != addr])

    @property
    def has_proxies(self) -> bool:
        return bool(self.fresh_proxies or self.good_proxies)

    @property
    def fresh_count(self) -> int:
        return len(self.fresh_proxies)

    @property
    def good_count(self) -> int:
        return len(self.good_proxies)


async def is_dashboard_rendered(page) -> bool:
    """Checks whether the Inferbase dashboard or authenticated app layout has legitimately rendered."""
    try:
        url = page.url or ""
        if "/onboarding" in url:
            return False
        if "/dashboard" in url or "/api-keys" in url:
            res = await page.evaluate("""() => {
                const navLinks = document.querySelectorAll('a[href*="/api-keys"], a[href*="/dashboard"], a[href*="/usage"], a[href*="/routing-policies"]');
                const btns = Array.from(document.querySelectorAll('button'));
                const hasGoDash = btns.some(b => b.textContent && b.textContent.includes('Go to Dashboard'));
                const hasYourAccountReady = document.body ? document.body.innerText.includes('Your account is ready') : false;
                return navLinks.length > 0 && !hasGoDash && !hasYourAccountReady;
            }""")
            return bool(res)
    except Exception:
        pass
    return False


async def handle_onboarding(page, logger) -> bool:
    """Handles Inferbase onboarding survey: clicks 'Get started', loops 'Skip', and confirms Dashboard is legitimately rendered."""
    current_url = page.url or ""
    logger.info(f"checking onboarding status on {current_url}...")

    # If already on rendered dashboard, we are done
    if await is_dashboard_rendered(page):
        logger.info("✅ Dashboard inferbase sudah aktif dan ter-render!")
        return True

    if "/onboarding" not in current_url and "/dashboard" not in current_url:
        logger.info(f"navigating to onboarding: {ONBOARDING_URL}")
        try:
            await page.goto(ONBOARDING_URL, wait_until="domcontentloaded", timeout=30000)
            await human_delay(1500, 2500)
        except Exception as e:
            logger.warn(f"onboarding navigation error: {e}")

    # Check for 'Get started' button
    try:
        get_started = await page.wait_for_selector('button:has-text("Get started")', timeout=6000)
        if get_started and await get_started.is_visible():
            logger.info("clicking 'Get started' onboarding button...")
            await get_started.click()
            await human_delay(1500, 2500)
    except Exception:
        pass

    # Loop clicking 'Skip' until 'Go to Dashboard' is visible or dashboard reached
    for step in range(1, 12):
        if await is_dashboard_rendered(page):
            logger.info("dashboard reached during onboarding!")
            return True

        # Check 'Go to Dashboard' button
        go_dash = await page.query_selector('button:has-text("Go to Dashboard"), button:has-text("Go to dashboard")')
        if go_dash and await go_dash.is_visible():
            logger.info("found 'Go to Dashboard' button, resolving transition to dashboard...")
            break

        # Check 'Skip' button
        try:
            skip_btn = await page.query_selector('button:has-text("Skip")')
            if skip_btn and await skip_btn.is_visible():
                logger.info(f"clicking 'Skip' button (step {step})...")
                await skip_btn.click()
                await human_delay(1200, 2000)
                continue
        except Exception:
            pass

        # Check 'Continue' button as fallback
        try:
            cont_btn = await page.query_selector('button:has-text("Continue")')
            if cont_btn and await cont_btn.is_visible():
                logger.info(f"clicking 'Continue' button (step {step})...")
                await cont_btn.click()
                await human_delay(1200, 2000)
                continue
        except Exception:
            pass

        await asyncio.sleep(1)

    # ── Ensure 'Go to Dashboard' succeeds and Dashboard is rendered ──────────
    logger.info("memastikan halaman dashboard ter-render (menangani toast error jika ada)...")
    for attempt in range(1, 7):
        if await is_dashboard_rendered(page):
            logger.info("✅ Halaman dashboard inferbase berhasil di-render!")
            return True

        # Check if 'Go to Dashboard' button is present and click it
        go_dash = await page.query_selector('button:has-text("Go to Dashboard"), button:has-text("Go to dashboard")')
        if go_dash and await go_dash.is_visible():
            logger.info(f"mengklik tombol 'Go to Dashboard' (percobaan #{attempt}/6)...")
            try:
                await go_dash.click()
            except Exception:
                await page.evaluate("""() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Go to Dashboard'));
                    if (btn) btn.click();
                }""")
            await human_delay(2000, 3500)

        # Check if toast 'Something went wrong' appeared
        toast_msg = await page.evaluate("""() => {
            const toast = document.querySelector('[data-sonner-toast], [role="status"], [role="alert"]');
            if (toast && /something went wrong|failed|error/i.test(toast.textContent || '')) {
                return toast.textContent;
            }
            return null;
        }""")
        if toast_msg:
            logger.warn(f"⚠️ Toast error terdeteksi saat masuk dashboard: '{toast_msg.strip()}'. Mencoba klik ulang 'Go to Dashboard'...")
            await human_delay(1500, 2500)
            continue

        # Wait up to 5s to see if page redirected
        for _ in range(5):
            if await is_dashboard_rendered(page):
                logger.info("✅ Halaman dashboard inferbase berhasil di-render!")
                return True
            await asyncio.sleep(1)

        # If still on onboarding on attempt >= 3, try navigating directly to /dashboard
        if attempt >= 3 and "/dashboard" not in (page.url or ""):
            logger.info(f"mencoba navigasi langsung ke {DASHBOARD_URL}...")
            try:
                await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=25000)
                await human_delay(2000, 3000)
            except Exception as e:
                logger.warn(f"direct dashboard navigation error: {e}")

    # Final check
    if not await is_dashboard_rendered(page):
        logger.info(f"navigasi final ke dashboard: {DASHBOARD_URL}")
        await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=30000)
        await human_delay(2000, 3000)

    return True


async def create_and_extract_api_key(page, email: str, screenshot_dir: str, logger) -> str:
    """Navigates to /api-keys, creates a new key, and extracts the API token."""
    # Ensure dashboard was rendered before opening /api-keys
    if "/onboarding" in (page.url or ""):
        logger.info("masih berada di /onboarding, menyelesaikan onboarding terlebih dahulu...")
        await handle_onboarding(page, logger)

    logger.info(f"navigating to API keys page: {API_KEYS_URL}")
    await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
    await human_delay(2000, 3000)

    # If redirected back to /onboarding, resolve it
    if "/onboarding" in (page.url or ""):
        logger.info("dialihkan kembali ke /onboarding, memproses onboarding ulang...")
        await handle_onboarding(page, logger)
        await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=35000)
        await human_delay(2000, 3000)

    # Click 'Create key' button
    logger.info("waiting for 'Create key' button...")
    create_btn = await page.wait_for_selector('button:has-text("Create key")', timeout=20000)
    if not create_btn:
        raise RuntimeError("Create key button not found on /api-keys")
    await create_btn.click()
    await human_delay(1500, 2500)

    # Fill key name in modal
    logger.info("typing key name in modal dialog...")
    key_name_input = await page.wait_for_selector('input#key-name, input[placeholder*="Production, Development"]', timeout=15000)
    if not key_name_input:
        raise RuntimeError("Key name input not found in modal")

    random_key_name = f"Key-{random.randint(1000, 9999)}"
    await human_type(page, 'input#key-name, input[placeholder*="Production, Development"]', random_key_name)
    await human_delay(500, 1000)

    # Click 'Create key' in modal
    logger.info("submitting key creation modal...")
    modal_dialog = page.locator('div[role="dialog"]')
    modal_submit = modal_dialog.locator('button:has-text("Create key")')

    try:
        await modal_submit.wait_for(state="visible", timeout=10000)
        try:
            await modal_submit.click(timeout=8000)
        except Exception:
            await modal_submit.click(force=True, timeout=5000)
    except Exception as e:
        logger.warn(f"Modal 'Create key' button click issue ({e}), attempting JavaScript click fallback...")
        clicked = await page.evaluate("""() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
                const btns = Array.from(dialog.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent && b.textContent.trim() === 'Create key');
                if (btn) {
                    btn.click();
                    return true;
                }
            }
            return false;
        }""")
        if not clicked:
            await page.keyboard.press("Enter")

    await human_delay(2500, 4000)

    # Extract API key
    logger.info("extracting generated API key...")
    api_key: Optional[str] = None

    for attempt in range(12):
        # 1. Check code tags
        code_elements = await page.query_selector_all("code")
        for code_el in code_elements:
            text = (await code_el.text_content() or "").strip()
            match = API_KEY_RE.search(text)
            if match:
                api_key = match.group(0)
                break

        if api_key:
            break

        # 2. Check full page content
        content = await page.content() or ""
        match = API_KEY_RE.search(content)
        if match:
            api_key = match.group(0)
            break

        await asyncio.sleep(1)

    if not api_key:
        os.makedirs(screenshot_dir, exist_ok=True)
        ss_path = os.path.join(screenshot_dir, f"api_key_fail_{re.sub(r'[^a-zA-Z0-9]', '_', email)}.png")
        await page.screenshot(path=ss_path)
        raise RuntimeError(f"Failed to extract API key matching inf_... (screenshot: {ss_path})")

    logger.info(f"API key successfully obtained: {api_key[:12]}...")

    # Click 'Done' button to close modal
    try:
        modal_dialog = page.locator('div[role="dialog"]')
        done_btn = modal_dialog.locator('button:has-text("Done")')
        if await done_btn.count() > 0 and await done_btn.is_visible():
            await done_btn.click()
            await human_delay(500, 1000)
        else:
            await page.keyboard.press("Escape")
    except Exception:
        pass

    return api_key


async def run_single_account(
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
    """Executes Inferbase signup via TempMail with email verification link & API key generation."""
    logger.info(f"starting Inferbase TempMail signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    delay_mult = 1.3 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            # Rule 1: Always new_context then new_page
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            fp = await get_browser_fingerprint_info(page)
            if fp:
                gpu_tag = f" | GPU={fp.get('renderer')[:35]}" if fp.get('renderer') and fp.get('renderer') != 'unknown' else ""
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')}{gpu_tag} | UA={fp.get('ua')}")

            # ── 1. Navigate to /register ────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(1800 * delay_mult), int(3000 * delay_mult))

            # ── 2. Fill Registration Form ───────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.SIGNUP})
            full_name = generate_random_name()
            company = generate_random_company()
            logger.info(f"filling registration form: {full_name} ({company}) <{email}>")

            await page.wait_for_selector('input#email, input[name="email"]', timeout=20000)

            await human_type(page, 'input#email, input[name="email"]', email, min_delay_ms=30, max_delay_ms=80)
            await human_delay(int(300 * delay_mult), int(600 * delay_mult))

            await human_type(page, 'input#full_name, input[name="full_name"]', full_name, min_delay_ms=30, max_delay_ms=80)
            await human_delay(int(300 * delay_mult), int(600 * delay_mult))

            await human_type(page, 'input#company, input[name="company"]', company, min_delay_ms=30, max_delay_ms=80)
            await human_delay(int(300 * delay_mult), int(600 * delay_mult))

            await human_type(page, 'input#password, input[name="password"]', password, min_delay_ms=30, max_delay_ms=80)
            await human_delay(int(300 * delay_mult), int(600 * delay_mult))

            await human_type(page, 'input#confirmPassword, input[name="confirmPassword"]', password, min_delay_ms=30, max_delay_ms=80)
            await human_delay(int(600 * delay_mult), int(1200 * delay_mult))

            # ── 3. Resolve Cloudflare Turnstile if present ───────────────────
            logger.info("checking for Cloudflare Turnstile on register...")
            turnstile_solved = False

            # Ensure Turnstile container is scrolled into center view
            try:
                await page.evaluate("""() => {
                    const cf = document.querySelector('input[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
                    if (cf) {
                        cf.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    } else {
                        const submit = document.querySelector('button[type="submit"]');
                        if (submit) submit.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }""")
                await asyncio.sleep(0.5)
            except Exception:
                pass

            # Check if token is already present
            token_val = await page.evaluate("""() => {
                const inp = document.querySelector('input[name="cf-turnstile-response"]');
                return inp ? inp.value : '';
            }""")
            if token_val and len(token_val) > 10:
                turnstile_solved = True
                logger.info("Cloudflare Turnstile token ready!")
            else:
                logger.info("🛡️ Cloudflare Turnstile terdeteksi: melakukan verifikasi otomatis...")
                for attempt in range(1, 4):
                    await dismiss_turnstile_modal(page, logger=logger)
                    token_val = await page.evaluate("""() => {
                        const inp = document.querySelector('input[name="cf-turnstile-response"]');
                        return inp ? inp.value : '';
                    }""")
                    if token_val and len(token_val) > 10:
                        turnstile_solved = True
                        logger.info("Cloudflare Turnstile token ready!")
                        break

                    logger.info(f"[turnstile] Mencoba verifikasi otomatis #{attempt}...")
                    solved = await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger, use_api=False)
                    if solved:
                        turnstile_solved = True
                        logger.info("✅ Cloudflare Turnstile berhasil diselesaikan secara otomatis!")
                        break
                    await asyncio.sleep(1.0)

                # Fallback for headed mode if interactive image captcha was presented
                if not turnstile_solved and headed:
                    logger.info("🛡️ Cloudflare Turnstile memerlukan verifikasi interaktif. Menunggu centang manual (s.d. 30s)...")
                    wait_deadline = time.time() + 30
                    last_notice = 0
                    while time.time() < wait_deadline:
                        await dismiss_turnstile_modal(page, logger=logger)
                        token_val = await page.evaluate("""() => {
                            const inp = document.querySelector('input[name="cf-turnstile-response"]');
                            return inp ? inp.value : '';
                        }""")
                        if token_val and len(token_val) > 10:
                            turnstile_solved = True
                            logger.info("✅ Cloudflare Turnstile berhasil diverifikasi!")
                            break

                        remaining = int(wait_deadline - time.time())
                        if time.time() - last_notice >= 10:
                            logger.info(f"⏳ Menunggu verifikasi Turnstile ({remaining}s tersisa)...")
                            last_notice = time.time()
                        await asyncio.sleep(1.0)

            # Wait for submit button to be enabled
            logger.info("waiting for submit button to become enabled...")
            for _ in range(16):
                disabled = await page.evaluate("""() => {
                    const btn = document.querySelector('button[type="submit"]');
                    return btn ? (btn.disabled || btn.getAttribute('disabled') !== null) : false;
                }""")
                if not disabled:
                    break
                await asyncio.sleep(0.5)

            # ── 4. Submit Registration ──────────────────────────────────────
            logger.info("submitting registration form...")
            submit_btn = await page.wait_for_selector('button[type="submit"]', timeout=10000)
            if not submit_btn:
                raise RuntimeError("Submit button not found on registration page")
            await submit_btn.click()
            await human_delay(3000, 5000)

            # Check if Turnstile popped up or re-prompted after submit
            await resolve_turnstile_if_present(page, timeout_sec=8, logger=logger, use_api=False)

            # ── 5. Retrieve Verification Link from TempMail ─────────────────
            logger.info(f"waiting for verification email from TempMail on {email}...")
            store.upsert({"email": email, "password": password, "status": FlowState.EMAIL_VERIFIED})

            verify_url = await temp_mail.wait_for_verification_link(
                email,
                link_pattern=VERIFY_LINK_RE,
                filter_sender="",
                timeout_sec=90,
                interval_sec=3.0,
            )
            verify_url = verify_url.rstrip(")>]\"',.")
            logger.info(f"verification link received: {verify_url}")

            # ── 6. Navigate to Verification URL & Verify Email ──────────────
            logger.info(f"navigating to verification link: {verify_url}")
            await page.goto(verify_url, wait_until="domcontentloaded", timeout=35000)
            await human_delay(1500, 2500)

            # Confirm email verification status on page
            try:
                verified_el = await page.wait_for_selector('text="Email verified", a[href="/playground"], a:has-text("Go to Playground")', timeout=8000)
                if verified_el:
                    logger.info("email successfully verified!")
            except Exception:
                logger.info("verification page loaded, proceeding to onboarding...")

            # Direct navigation to onboarding URL as requested
            logger.info(f"navigating directly to onboarding: {ONBOARDING_URL}")
            await page.goto(ONBOARDING_URL, wait_until="domcontentloaded", timeout=30000)
            await human_delay(1500, 2500)

            # ── 7. Complete Onboarding ──────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.ONBOARDING})
            await handle_onboarding(page, logger)

            # ── 8. Create & Extract API Key ─────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)

            # ── 9. Save Success ─────────────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            logger.info(f"SUCCESS for {email}! API Key: {api_key}")
            return True

    except Exception as e:
        error_msg = str(e)
        logger.error(f"FAILED for {email}: {error_msg}")
        store.upsert({"email": email, "status": FlowState.FAILED, "notes": error_msg})
        results.mark_failed(email, error_msg)
        return False


async def run_single_google_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
) -> bool:
    """Executes Inferbase signup via Google OAuth with onboarding completion & API key generation."""
    email = account.email
    password = account.password
    logger.info(f"starting Inferbase Google OAuth signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    delay_mult = 1.3 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            # Rule 1: Always new_context then new_page
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            fp = await get_browser_fingerprint_info(page)
            if fp:
                gpu_tag = f" | GPU={fp.get('renderer')[:35]}" if fp.get('renderer') and fp.get('renderer') != 'unknown' else ""
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')}{gpu_tag} | UA={fp.get('ua')}")

            # ── 1. Navigate to /register ────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(1800 * delay_mult), int(3000 * delay_mult))

            # ── 2. Click 'Continue with Google' ─────────────────────────────
            logger.info("clicking 'Continue with Google'...")
            google_link = await page.wait_for_selector('a[href*="/auth/google/start"], a:has-text("Continue with Google")', timeout=20000)
            if not google_link:
                raise RuntimeError("Continue with Google link not found on /register")
            await google_link.click()
            await human_delay(2000, 3500)

            # ── 3. Perform Google OAuth ─────────────────────────────────────
            logger.info(f"performing Google OAuth login for {email}...")
            await perform_google_oauth(
                page,
                email=email,
                password=password,
                recovery_email=account.recovery_email,
                logger=logger,
                pace=pace,
            )

            # Wait for OAuth redirect back to inferbase.ai
            logger.info("waiting for OAuth redirect back to Inferbase...")
            redirect_deadline = time.time() + 45
            while time.time() < redirect_deadline:
                current_url = page.url or ""
                if "inferbase.ai" in current_url and "accounts.google.com" not in current_url:
                    break
                await asyncio.sleep(1)

            # ── 4. Complete Onboarding ──────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.ONBOARDING})
            await handle_onboarding(page, logger)

            # ── 5. Create & Extract API Key ─────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)

            # ── 6. Save Success ─────────────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.DONE, "apiKey": api_key})
            results.mark_success(email, password, api_key)
            logger.info(f"SUCCESS for Google OAuth account {email}! API Key: {api_key}")
            return True

    except GooglePhoneVerificationException:
        logger.error(f"Google phone verification required for {email}")
        store.upsert({"email": email, "status": FlowState.FAILED, "notes": "PHONE_VERIFICATION_REQUIRED"})
        results.mark_failed(email, "PHONE_VERIFICATION_REQUIRED")
        return False
    except Exception as e:
        error_msg = str(e)
        logger.error(f"FAILED for {email}: {error_msg}")
        store.upsert({"email": email, "status": FlowState.FAILED, "notes": error_msg})
        results.mark_failed(email, error_msg)
        return False


def get_all_inferbase_result_files() -> List[str]:
    candidates = [
        "akun-result-inferbase.txt",
        "vps/akun-result-inferbase.txt",
        "inferbase-ai-dataset/akun-result-inferbase.txt",
    ]
    return [c for c in candidates if os.path.exists(c)]

def get_completed_emails(store: JsonlStore, results: ResultWriter) -> Set[str]:
    completed = set(results.get_successful_emails())
    completed.update(store.get_all_done_emails())
    return completed


async def main_async():
    parser = argparse.ArgumentParser(description="Inferbase AI Signup Automation (Camoufox engine)")
    parser.add_argument("--headed", action="store_true", help="Run headed browser")
    parser.add_argument("--auth", choices=["tempmail", "google"], default="tempmail", help="Auth method")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between accounts in seconds")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of accounts to process")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Parallel worker concurrency")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default="human", help="Automation pace")
    parser.add_argument("--domain", default="ifqy.net", help="TempMail domain")
    parser.add_argument("--accounts-file", help="File with accounts (gsuite.txt)")
    parser.add_argument("--state-file", default="state-inferbase.jsonl", help="State file")
    parser.add_argument("--with-proxy", dest="use_proxy", action="store_true", default=True, help="Use proxy")
    parser.add_argument("--no-proxy", dest="use_proxy", action="store_false", help="Run direct without proxy")
    parser.add_argument("--proxy-file", help="Explicit proxy file")
    parser.add_argument("--proxy-timeout", type=float, default=float(os.getenv("PROXY_PRECHECK_TIMEOUT", "6.0")), help="Timeout in seconds for proxy Inferbase HTTP 200 pre-check (default: 6.0s)")
    parser.add_argument("--skip-proxy-precheck", action="store_true", help="Skip HTTP 200 proxy pre-check")
    parser.add_argument("--reuse-proxy", action="store_true", help="Rotate & reuse proxies")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Dry run validation")

    args = parser.parse_args()
    logger = create_logger("inferbase")
    setup_process_signals()

    state_file = args.state_file
    result_success_file = "akun-result-inferbase.txt"
    result_failed_file = "akun-failed-inferbase.txt"
    api_key_file = "apikey-inferbase.txt"
    screenshot_dir = "screenshots-inferbase"

    key_files = [api_key_file]
    if os.path.exists("inferbase-ai-dataset"):
        key_files.append("inferbase-ai-dataset/apikey-inferbase.txt")

    store = JsonlStore(state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file=result_success_file,
        account_failed_file=result_failed_file,
        fallback_result_files=get_all_inferbase_result_files(),
    )

    # Resolve proxies
    proxy_file = args.proxy_file
    if not proxy_file:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    proxies = load_proxies(proxy_file) if (args.use_proxy and proxy_file) else []
    proxy_pool = SmartProxyPool(proxies, reuse_proxy=args.reuse_proxy) if proxies else None

    logger.info(f"Loaded {len(proxies)} proxies for Inferbase (reuse={args.reuse_proxy})")

    # ── 1. Google OAuth Flow ────────────────────────────────────────────────
    if args.auth == "google":
        accounts_file = args.accounts_file
        if not accounts_file:
            if os.path.exists("inferbase-ai-dataset/gsuite.txt"):
                accounts_file = "inferbase-ai-dataset/gsuite.txt"
            elif os.path.exists("gsuite.txt"):
                accounts_file = "gsuite.txt"

        if not accounts_file or not os.path.exists(accounts_file):
            logger.error("Google OAuth mode requested but no accounts file (gsuite.txt) found!")
            sys.exit(1)

        accounts = load_accounts(accounts_file)
        completed = get_completed_emails(store, results)
        todo_accounts = [a for a in accounts if a.email.lower() not in completed]
        target_count = args.limit if args.limit > 0 else (len(todo_accounts) if todo_accounts else 1)
        worker_count = max(1, min(args.workers, target_count))
        logger.info(f"Google accounts: total={len(accounts)}, completed={len(completed)}, todo={len(todo_accounts)}")
        logger.info(f"Execution plan: auth=google, target={target_count}, workers={worker_count}, pace={args.pace}")

        if args.dry_run:
            logger.info("Dry-run validation complete. Exiting.")
            return

        queue = list(todo_accounts)
        success_count = 0
        lock = asyncio.Lock()

        async def google_worker(worker_id: int):
            nonlocal success_count
            while True:
                account: Optional[Account] = None
                async with lock:
                    if success_count >= target_count or not queue:
                        break
                    account = queue.pop(0)

                proxy = None
                if args.use_proxy and proxy_pool:
                    proxy = await proxy_pool.get_next_live_proxy(
                        target_url=DEFAULT_SIGNUP_URL,
                        timeout_sec=args.proxy_timeout,
                        logger=logger,
                        enable_precheck=(not args.skip_proxy_precheck),
                    )
                    if proxy is None:
                        logger.warning(
                            f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left."
                        )
                        async with lock:
                            if account:
                                queue.insert(0, account)
                        break
                    proxy_addr = proxy_pool.address_of(proxy)
                    reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                    logger.info(
                        f"Worker #{worker_id} selected verified proxy: {proxy.server} ({proxy_addr}){reuse_tag}. "
                        f"(Fresh remaining: {proxy_pool.fresh_count}, Good pool: {proxy_pool.good_count})"
                    )
                acc_logger = create_logger(f"w{worker_id}:{account.email}")
                ok = await run_single_google_account(
                    account=account,
                    proxy=proxy,
                    store=store,
                    results=results,
                    headed=args.headed,
                    screenshot_dir=screenshot_dir,
                    logger=acc_logger,
                    pace=args.pace,
                )
                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, ok)

                if ok:
                    async with lock:
                        success_count += 1
                        logger.info(f"Worker #{worker_id} progress: {success_count}/{target_count} succeeded.")

                if success_count < target_count and args.delay > 0:
                    await asyncio.sleep(args.delay)

        await asyncio.gather(*(google_worker(i + 1) for i in range(worker_count)))
        logger.info(f"Inferbase Google OAuth finished! Total succeeded: {success_count}/{target_count}")
        return

    # ── 2. TempMail Flow ────────────────────────────────────────────────────
    # In TempMail mode: NEVER use gsuite.txt! Dynamically generate fresh email via TempMail API
    tempmail_domain = args.domain or "ifqy.net"
    if tempmail_domain.startswith("temp."):
        tempmail_domain = tempmail_domain[5:]
    if "://" in tempmail_domain:
        tempmail_domain = tempmail_domain.split("://")[1].split("/")[0]
        if tempmail_domain.startswith("temp."):
            tempmail_domain = tempmail_domain[5:]

    temp_mail_base_url = os.getenv("TEMPMAIL_BASE_URL", "https://temp.ifqy.net")
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
                    logger.warning(
                        f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left."
                    )
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

            password = "torabikA1#"
            acc_logger = create_logger(f"w{worker_id}:{email}")

            ok = await run_single_account(
                email=email,
                password=password,
                proxy=proxy,
                store=store,
                results=results,
                temp_mail=temp_mail,
                headed=args.headed,
                screenshot_dir=screenshot_dir,
                logger=acc_logger,
                pace=args.pace,
            )

            if proxy_pool and proxy:
                proxy_pool.mark_result(proxy, ok)

            if ok:
                async with lock:
                    success_count += 1
                    logger.info(f"Worker #{worker_id} progress: {success_count}/{count} succeeded.")

            if success_count < count and args.delay > 0:
                await asyncio.sleep(args.delay)

    await asyncio.gather(*(tempmail_worker(i + 1) for i in range(worker_count)))
    logger.info(f"Inferbase TempMail automation finished! Total succeeded: {success_count}/{count}")


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n[camoufox] Signal received, terminating...")
    finally:
        kill_descendant_processes()

if __name__ == "__main__":
    main()
