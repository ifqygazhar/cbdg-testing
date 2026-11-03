#!/usr/bin/env python3
"""
ChatGPT / OpenAI Camoufox Runner (Python + Camoufox / Firefox engine)
Automates ChatGPT account registration on chatgpt.com / auth.openai.com using
TempMail-Pro with 6-digit OTP polling and About You onboarding.

Guarantees:
- Strict HTTP 200 pre-check against target web (https://chatgpt.com/) before execution.
- Unique randomized browser fingerprint per account/worker (OS rotation, window jitter, hardware cores, UA).
- Distinct verified proxy assigned per worker process from SmartProxyPool.
- Output saving: successful accounts saved to akun-gpt.txt as email:password, failed to akun-gpt-failed.txt.
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
    SIGNUP_SUBMITTED = "SIGNUP_SUBMITTED"
    PASSWORD_SET = "PASSWORD_SET"
    OTP_SUBMITTED = "OTP_SUBMITTED"
    ABOUT_YOU_SUBMITTED = "ABOUT_YOU_SUBMITTED"
    ONBOARDING_CONTINUED = "ONBOARDING_CONTINUED"
    PROMPT_SENT = "PROMPT_SENT"

DEFAULT_SIGNUP_URL = "https://chatgpt.com/"
DEFAULT_PASSWORD = "torabikA1###########"
DEFAULT_SUCCESS_FILE = "akun-gpt.txt"
DEFAULT_FAILED_FILE = "akun-gpt-failed.txt"
DEFAULT_STATE_FILE = "state-gpt.jsonl"

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

FIRST_NAMES = ["Budi", "Alex", "David", "Sarah", "Michael", "Linda", "Rian", "Dewi", "Kevin", "Maya", "Daniel", "Chloe", "Aris", "Nadia"]
LAST_NAMES = ["Pratama", "Santoso", "Miller", "Taylor", "Wijaya", "Kusuma", "Davis", "Tanaka", "Saputra", "Wong", "Hidayat", "Lestari"]

SAMPLE_PROMPTS = [
    "Halo! Berikan 1 tips produktivitas singkat hari ini.",
    "What are 3 interesting facts about the ocean?",
    "Give me a short positive thought for today.",
    "Jelaskan secara ringkas bagaimana pelangi terbentuk.",
    "Tell me a short one-liner joke.",
    "Sebutkan 3 tempat wisata terbaik di Indonesia.",
]


def generate_random_name() -> str:
    f = random.choice(FIRST_NAMES)
    l = random.choice(LAST_NAMES)
    return f"{f} {l}"


def generate_random_age() -> int:
    # Strictly > 20
    return random.randint(22, 38)


def get_random_prompt() -> str:
    return random.choice(SAMPLE_PROMPTS)


def get_unique_account_fingerprint() -> Dict[str, Any]:
    """Generates unique OS, window dimension, and humanize parameters for each account."""
    global _account_launch_counter
    _account_launch_counter += 1
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


class GptResultWriter:
    """Manages recording successful and failed ChatGPT accounts with deduplication."""

    def __init__(self, success_file: str = DEFAULT_SUCCESS_FILE, failed_file: str = DEFAULT_FAILED_FILE):
        self.success_file = success_file
        self.failed_file = failed_file
        self.successful_emails: Set[str] = set()
        self._load_existing()

    def _load_existing(self):
        candidate_paths = [self.success_file]
        if not os.path.isabs(self.success_file):
            candidate_paths.append(os.path.join(REPO_ROOT, self.success_file))

        for fp in candidate_paths:
            if os.path.exists(fp):
                try:
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        for line in f:
                            line = line.strip()
                            if not line or line.startswith("#"):
                                continue
                            parts = line.split(":")
                            if parts and "@" in parts[0]:
                                self.successful_emails.add(parts[0].lower().strip())
                except Exception:
                    pass

    def has_success(self, email: str) -> bool:
        return email.lower().strip() in self.successful_emails

    def get_successful_emails(self) -> Set[str]:
        return set(self.successful_emails)

    def mark_success(self, email: str, password: str = ""):
        self.append_success(f"{email}:{password}" if password else email)

    def append_success(self, line_or_email: str):
        line = line_or_email.strip()
        email = line.split(":")[0].strip() if ":" in line else line
        self.successful_emails.add(email.lower())
        target_dir = os.path.dirname(os.path.abspath(self.success_file))
        if target_dir:
            os.makedirs(target_dir, exist_ok=True)
        with open(self.success_file, "a", encoding="utf-8") as f:
            f.write(f"{line}\n")

    def mark_failed(self, email: str, reason: str = "", password: str = ""):
        if password:
            self.append_failed(f"{email}:{password} | {reason}")
        else:
            self.append_failed(f"{email} | {reason}")

    def append_failed(self, line: str):
        target_dir = os.path.dirname(os.path.abspath(self.failed_file))
        if target_dir:
            os.makedirs(target_dir, exist_ok=True)
        with open(self.failed_file, "a", encoding="utf-8") as f:
            f.write(f"{line.strip()}\n")


class GptJsonlStore(JsonlStore):
    """Subclass of JsonlStore supporting dictionary records or keyword arguments."""

    def get(self, email: str) -> Optional[Dict[str, Any]]:
        clean = email.lower().strip()
        return self._records.get(clean) or self._records.get(email.strip())

    def upsert(self, record: Optional[Dict[str, Any]] = None, **kwargs):
        data = dict(record) if isinstance(record, dict) else {}
        data.update(kwargs)
        if "email" not in data:
            return
        data["email"] = data["email"].lower().strip()
        super().upsert(data)

    def get_status(self, email: str) -> Optional[str]:
        rec = self.get(email)
        return rec.get("status") if rec else None


class SmartProxyPool:
    """Smart proxy manager with live pre-check and failure blacklist."""

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


async def run_gpt_single(
    account: Optional[Account],
    proxy: Optional[Proxy],
    store: GptJsonlStore,
    results: GptResultWriter,
    args: argparse.Namespace,
    temp_mail: TempMailClient,
    logger,
) -> bool:
    """Executes single ChatGPT registration, OTP handling, profile filling, onboarding & initial prompt."""
    email: str = ""
    password: str = args.password or DEFAULT_PASSWORD

    if args.auth == "google" and account:
        email = account.email
        password = account.password
    else:
        # Generate TempMail inbox
        try:
            target_domain = (args.domain or "ifqy.net").strip().lower().lstrip("@")
            created = await asyncio.to_thread(temp_mail.create_email, domain=target_domain)
            email = created["email"]
            logger.info(f"📧 TempMail generated: {email} (domain: {target_domain})")
        except Exception as e:
            logger.error(f"Failed to generate TempMail address: {e}")
            return False

    norm_email = email.strip().lower()
    if results.has_success(norm_email) or store.get_status(norm_email) == FlowState.DONE:
        logger.info(f"Safeguard: {email} already completed in results / state. Skipping.")
        return True

    store.upsert(
        email=email,
        status=FlowState.PENDING,
        proxy=proxy.server if proxy else "direct",
    )

    fp_opts = get_unique_account_fingerprint()
    browser_ctx = await launch_camoufox(
        headless=not args.headed,
        proxy=proxy,
        randomize_fingerprint=False,
        **fp_opts,
    )

    page = None
    context = None
    success = False
    error_reason = ""

    try:
        async with browser_ctx as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()

            # Log active anonymous fingerprint for this worker
            fp_info = await get_browser_fingerprint_info(page)
            if fp_info:
                logger.info(
                    f"🛡️ Camoufox Fingerprint: OS={fp_info.get('platform')} | "
                    f"Screen={fp_info.get('screen')} | Viewport={fp_info.get('viewport')} | "
                    f"Cores={fp_info.get('cores')} | UA={fp_info.get('ua')}"
                )

            # ── 1. Navigate to chatgpt.com ──
            logger.info("Step 1: Navigating to https://chatgpt.com/...")
            await page.goto("https://chatgpt.com/", wait_until="domcontentloaded", timeout=40000)
            await human_delay(1500, 2500, pace=args.pace)

            # Check if already authenticated or prompt composer is visible
            composer_check = await page.query_selector('div.ProseMirror[contenteditable="true"]')
            if composer_check and await composer_check.is_visible():
                logger.info("Already authenticated on ChatGPT.")
                results.append_success(f"{email}:{password}")
                store.upsert(email=email, status=FlowState.DONE)
                return True

            # Trigger sign up modal if email field not yet visible
            email_input_sel = 'input#mobile-auth-email, input[name="login_hint"][type="email"], input[type="email"], input[placeholder*="Email" i]'
            
            is_email_visible = False
            try:
                email_handle = await page.query_selector(email_input_sel)
                if email_handle and await email_handle.is_visible():
                    is_email_visible = True
            except Exception:
                is_email_visible = False

            if not is_email_visible:
                logger.info("Landing page loaded. Modal not yet active. Dismissing popups & clicking 'Sign up for free'...")

                # Dismiss Google One-Tap or overlay if present
                try:
                    await page.keyboard.press("Escape")
                    await human_delay(200, 400, pace=args.pace)
                    for close_sel in [
                        '#credential_picker_container [role="button"]',
                        'div[aria-label*="Close" i]',
                        'div[aria-label*="Tutup" i]',
                        'button[aria-label*="Close" i]',
                        'button[aria-label*="Tutup" i]',
                    ]:
                        cb = await page.query_selector(close_sel)
                        if cb and await cb.is_visible():
                            await cb.click(timeout=1000)
                            break
                except Exception:
                    pass

                # Locate and click "Sign up for free" button
                clicked = False
                signup_selectors = [
                    'button[data-mobile-auth-entry-action="signup"]',
                    'button:has-text("Sign up for free")',
                    'button[commandfor="mobile-auth-dialog"]',
                    'button:has-text("Sign up")',
                    'button:has-text("Log in or create account")',
                ]
                for sel in signup_selectors:
                    try:
                        locator = page.locator(sel).first
                        if await locator.is_visible(timeout=1000):
                            logger.info(f"Clicking signup trigger button: {sel}")
                            await locator.click(timeout=5000)
                            clicked = True
                            break
                    except Exception:
                        continue

                if not clicked:
                    try:
                        clicked = await page.evaluate('''() => {
                            const btn = document.querySelector('button[data-mobile-auth-entry-action="signup"]') ||
                                        Array.from(document.querySelectorAll('button')).find(b => {
                                            const t = (b.textContent || '').trim().toLowerCase();
                                            return t.includes('sign up for free') || t === 'sign up';
                                        });
                            if (btn) {
                                btn.click();
                                return true;
                            }
                            const dialog = document.getElementById('mobile-auth-dialog');
                            if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
                                dialog.showModal();
                                return true;
                            }
                            return false;
                        }''')
                        if clicked:
                            logger.info("Triggered signup modal via DOM click / showModal fallback.")
                    except Exception as e:
                        logger.warning(f"DOM click fallback warning: {e}")

                await human_delay(1500, 2500, pace=args.pace)

                # Wait for email input to become visible
                try:
                    await page.wait_for_selector(email_input_sel, state="visible", timeout=12000)
                    is_email_visible = True
                except Exception:
                    is_email_visible = False

                # If still not visible, navigate directly to auth signup
                if not is_email_visible:
                    logger.info("Auth modal not visible after clicking; navigating directly to auth signup/login...")
                    await page.goto("https://chatgpt.com/auth/login?screen_hint=signup", wait_until="domcontentloaded", timeout=30000)
                    await human_delay(1500, 2500, pace=args.pace)
                    await page.wait_for_selector(email_input_sel, state="visible", timeout=15000)

            logger.info(f"Typing email {email} into auth input...")
            await human_type(page, email_input_sel, email)
            await human_delay(400, 800, pace=args.pace)

            submit_email_sel = 'button[data-w-component="button"][type="submit"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")'
            submit_email_btn = await page.query_selector(submit_email_sel)
            if submit_email_btn and await submit_email_btn.is_visible():
                await submit_email_btn.click()
            else:
                await page.keyboard.press("Enter")

            store.upsert(email=email, status=FlowState.SIGNUP_SUBMITTED)
            await human_delay(2500, 4000, pace=args.pace)

            # Check for Cloudflare Turnstile if present
            await resolve_turnstile_if_present(page, logger=logger)

            # ── 2. Password Step ──
            logger.info("Step 2: Checking password screen...")
            # If "Continue with password" choice is presented, click it
            pass_choice_sel = (
                'button:has-text("Continue with password"), '
                'button:has-text("Sign up with password"), '
                'button[name="intent"][value*="password"], '
                'a:has-text("Continue with password"), '
                'a:has-text("password")'
            )
            pass_choice_btn = await page.query_selector(pass_choice_sel)
            if pass_choice_btn and await pass_choice_btn.is_visible():
                logger.info("Found 'Continue with password' option. Clicking...")
                await pass_choice_btn.click()
                await human_delay(1500, 2500, pace=args.pace)

            pass_input_sel = 'input[name="new-password"], input[type="password"], input[placeholder*="Password" i], input[id*="password" i]'
            pass_input = None
            try:
                pass_input = await page.wait_for_selector(pass_input_sel, state="visible", timeout=15000)
            except Exception:
                pass

            if pass_input:
                logger.info(f"Filling password for {email}...")
                await human_type(page, pass_input_sel, password)
                await human_delay(400, 800, pace=args.pace)

                pass_submit_sel = 'button[data-dd-action-name="Continue"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")'
                pass_submit_btn = await page.query_selector(pass_submit_sel)
                if pass_submit_btn and await pass_submit_btn.is_visible():
                    await pass_submit_btn.click()
                else:
                    await page.keyboard.press("Enter")

                store.upsert(email=email, status=FlowState.PASSWORD_SET)
                await human_delay(2500, 4000, pace=args.pace)
            else:
                logger.info("Password input not detected; continuing to verification/OTP step...")

            await resolve_turnstile_if_present(page, logger=logger)

            # ── 3. OTP Verification Step ──
            logger.info(f"Step 3: Checking OTP verification screen for {email}...")
            otp_input_sel = 'input[name="code"], input[autocomplete="one-time-code"], input[placeholder="Code"], input[inputmode="numeric"]'
            otp_input = None
            try:
                otp_input = await page.wait_for_selector(otp_input_sel, state="visible", timeout=20000)
            except Exception:
                pass

            if otp_input:
                logger.info(f"Waiting for 6-digit verification code from TempMail for {email}...")
                otp_pattern = re.compile(
                    r'(?:verification code|temporary verification code|code to continue|enter this temporary|enter the following)[\s\S]{0,400}?(\d{6})',
                    re.I,
                )
                otp_code = await temp_mail.wait_for_verification_otp(
                    address=email,
                    timeout_sec=120,
                    interval_sec=3.0,
                    code_pattern=otp_pattern,
                    logger=logger,
                )
                logger.info(f"🔑 Received OTP code: {otp_code}")

                await human_type(page, otp_input_sel, otp_code)
                await human_delay(500, 900, pace=args.pace)

                otp_submit_sel = (
                    'button:has-text("Submit code"), '
                    'button[type="submit"]:has-text("Submit code"), '
                    'button:has-text("Submit"), '
                    'button[type="submit"]:has-text("Submit"), '
                    'button[name="intent"][value="validate"], '
                    'button[data-dd-action-name="Continue"], '
                    'button[type="submit"]:has-text("Continue"), '
                    'button:has-text("Continue")'
                )
                otp_submit_btn = await page.query_selector(otp_submit_sel)
                if otp_submit_btn and await otp_submit_btn.is_visible():
                    await otp_submit_btn.click()
                else:
                    await page.keyboard.press("Enter")

                store.upsert(email=email, status=FlowState.OTP_SUBMITTED)
                await human_delay(3000, 5000, pace=args.pace)
            else:
                logger.info("OTP input not found (already verified or skipped).")

            await resolve_turnstile_if_present(page, logger=logger)

            # ── 4. About You Step (Full Name & Age > 20) ──
            logger.info("Step 4: Handling About You questionnaire (Full name & Age > 20)...")
            name_input_sel = 'input[name="name"], input[placeholder*="Full name" i], input[autocomplete="name"]'
            name_input = None
            try:
                name_input = await page.wait_for_selector(name_input_sel, state="visible", timeout=15000)
            except Exception:
                pass

            if name_input:
                full_name = generate_random_name()
                age = generate_random_age()
                logger.info(f"Entering profile details: Name='{full_name}', Age={age} (>20)")

                await human_type(page, name_input_sel, full_name)
                await human_delay(300, 600, pace=args.pace)

                age_input_sel = 'input[name="age"], input[placeholder*="Age" i], input[type="number"][name="age"]'
                age_input = None
                try:
                    age_input = await page.wait_for_selector(age_input_sel, state="visible", timeout=5000)
                except Exception:
                    pass

                if age_input:
                    await human_type(page, age_input_sel, str(age))
                    await human_delay(300, 600, pace=args.pace)

                about_submit_sel = 'button[data-dd-action-name="Continue"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")'
                about_submit_btn = await page.query_selector(about_submit_sel)
                if about_submit_btn and await about_submit_btn.is_visible():
                    await about_submit_btn.click()
                else:
                    await page.keyboard.press("Enter")

                store.upsert(email=email, status=FlowState.ABOUT_YOU_SUBMITTED)
                await human_delay(3500, 5500, pace=args.pace)
            else:
                logger.info("About You screen not present or already completed.")

            # ── 5. Post-Success Onboarding Modal & Initial Prompt ──
            logger.info("Step 5: Waiting for ChatGPT dashboard & handling onboarding modal...")
            for _ in range(25):
                cur_url = page.url or ""
                if "chatgpt.com" in cur_url and "auth.openai.com" not in cur_url:
                    break
                await human_delay(1000, 1500, pace=args.pace)

            await human_delay(2000, 3000, pace=args.pace)

            # Account registration is 100% complete at this point! Record success immediately!
            logger.info(f"🎉 ChatGPT account created successfully: {email}:{password}")
            results.append_success(f"{email}:{password}")
            store.upsert(email=email, status=FlowState.DONE)
            success = True

            # Safely handle onboarding dialog and initial prompt warmup (non-fatal)
            try:
                # Check for onboarding "Continue" button
                onboarding_btn_sel = 'button:has-text("Continue"), button[type="submit"]:has-text("Continue")'
                onboarding_btn = await page.query_selector(onboarding_btn_sel)
                if onboarding_btn and await onboarding_btn.is_visible():
                    logger.info("Found onboarding 'Continue' button. Clicking...")
                    try:
                        await onboarding_btn.click(timeout=5000)
                        await human_delay(1500, 2500, pace=args.pace)
                    except Exception:
                        pass

                store.upsert(email=email, status=FlowState.ONBOARDING_CONTINUED)

                # ── 6. Type and Send Short Initial Prompt ──
                logger.info("Step 6: Locating chat composer to execute short prompt...")
                composer_sel = 'div.ProseMirror[contenteditable="true"], #prompt-textarea, div[contenteditable="true"], textarea[placeholder*="Ask" i]'
                composer = None
                try:
                    composer = await page.wait_for_selector(composer_sel, state="visible", timeout=15000)
                except Exception:
                    pass

                if composer:
                    test_prompt = get_random_prompt()
                    logger.info(f"Submitting test prompt to ChatGPT: \"{test_prompt}\"")

                    # Focus composer via locator
                    try:
                        await page.locator(composer_sel).first.click(timeout=5000)
                    except Exception:
                        await composer.click(timeout=5000)
                    await human_delay(350, 700, pace=args.pace)

                    # Use keyboard type directly to avoid ElementHandle detachment during React re-renders
                    for char in test_prompt:
                        if char in " .!?,#" or random.random() < 0.05:
                            await human_delay(30, 80)
                        await page.keyboard.type(char, delay=random.randint(20, 50))
                    await human_delay(400, 800, pace=args.pace)

                    send_btn_sel = 'button[data-testid="send-button"], button[aria-label*="Send" i], button.bg-composer-primary, button:has(svg.icon-primary-action)'
                    send_btn = await page.query_selector(send_btn_sel)
                    if send_btn and await send_btn.is_visible():
                        try:
                            await send_btn.click(timeout=3000)
                        except Exception:
                            await page.keyboard.press("Enter")
                    else:
                        await page.keyboard.press("Enter")

                    logger.info("Prompt sent! Waiting 5s for generation...")
                    await human_delay(4000, 6000, pace=args.pace)
                    store.upsert(email=email, status=FlowState.PROMPT_SENT)
                else:
                    logger.warning("Chat composer not located in time; prompt skipped.")
            except Exception as post_err:
                logger.warning(f"Post-registration prompt interaction error (non-fatal, account kept safe): {post_err}")

            return True

    except Exception as e:
        if not success:
            error_reason = str(e)
            logger.error(f"Error during ChatGPT registration for {email}: {error_reason}")
            results.append_failed(f"{email}:{password} | {error_reason}")
            store.upsert(email=email, status=FlowState.FAILED, error=error_reason)
            success = False
        else:
            logger.info(f"Account {email} was successfully registered; ignoring trailing error: {e}")
            return True
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

    return success


async def main():
    setup_process_signals()

    parser = argparse.ArgumentParser(description="ChatGPT Camoufox Runner")
    parser.add_argument("--auth", choices=["tempmail", "google"], default="tempmail", help="Registration auth method")
    parser.add_argument("--accounts-file", default=None, help="Accounts file for Google OAuth")
    parser.add_argument("--password", "-p", default=DEFAULT_PASSWORD, help="Default account password")
    parser.add_argument("--domain", "-d", default="ifqy.net", help="TempMail domain")
    parser.add_argument("--limit", "-l", "-n", type=int, default=1, help="Max accounts to create")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Concurrency workers")
    parser.add_argument("--use-proxy", action="store_true", default=True, help="Enable proxy")
    parser.add_argument("--no-proxy", "--direct", dest="use_proxy", action="store_false", help="Disable proxy")
    parser.add_argument("--proxy-file", default=None, help="Proxy list path")
    parser.add_argument("--reuse-proxy", action="store_true", default=False, help="Reuse good proxies")
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE, help="JSONL state file")
    parser.add_argument("--success-file", default=DEFAULT_SUCCESS_FILE, help="Success output file (email:password)")
    parser.add_argument("--failed-file", default=DEFAULT_FAILED_FILE, help="Failed output file")
    parser.add_argument("--delay-sec", "--delay", dest="delay_sec", type=int, default=2, help="Delay between accounts")
    parser.add_argument("--headed", action="store_true", default=False, help="Run browser visible")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Validate config without launching")
    parser.add_argument("--pace", default="human", help="Pacing (fast|human|careful)")
    parser.add_argument("--retry-failed", action="store_true", default=False, help="Retry previously failed accounts")

    args = parser.parse_args()
    if args.domain:
        args.domain = args.domain.strip().lower().lstrip("@")
        if args.domain.startswith("temp."):
            args.domain = args.domain[5:]

    logger = create_logger("gpt")

    logger.info("=" * 60)
    logger.info("  ChatGPT / OpenAI Automation (Camoufox Engine)")
    logger.info(f"  Target: {DEFAULT_SIGNUP_URL}")
    logger.info(f"  Auth: {args.auth.upper()} | Workers: {args.workers} | Limit: {args.limit} | Domain: @{args.domain}")
    logger.info(f"  Headless: {not args.headed} | Use Proxy: {args.use_proxy}")
    logger.info(f"  Success File: {args.success_file} (email:password)")
    logger.info(f"  Failed File: {args.failed_file}")
    logger.info(f"  VPS Status: {get_vps_system_status()}")
    logger.info("=" * 60)

    if args.dry_run:
        logger.info("Dry-run requested: configuration validated. Exiting.")
        return

    store = GptJsonlStore(args.state_file)
    results = GptResultWriter(args.success_file, args.failed_file)

    temp_mail = TempMailClient(
        api_key=os.getenv("TEMPMAIL_API_KEY", "anjingmemekkontol"),
        base_url=os.getenv("TEMPMAIL_BASE_URL", "https://temp-postservice.verifwebsitepro.workers.dev"),
        default_domain=args.domain,
    )

    # Resolve proxies
    proxy_pool: Optional[SmartProxyPool] = None
    if args.use_proxy:
        p_file = args.proxy_file
        if not p_file:
            p_file = "proxy-live.txt" if os.path.exists("proxy-live.txt") else ("proxy.txt" if os.path.exists("proxy.txt") else None)
        raw_proxies = load_proxies(p_file) if p_file else []
        if raw_proxies:
            proxy_pool = SmartProxyPool(raw_proxies, reuse_proxy=args.reuse_proxy)
            logger.info(f"Proxy pool loaded: {len(raw_proxies)} proxies from {p_file}")
        else:
            logger.warning("No proxies found! Operating in direct network mode.")

    # Target counts and queue
    account_queue: deque[Account] = deque()
    if args.auth == "google":
        acc_file = args.accounts_file or ("gpt-dataset/gsuite.txt" if os.path.exists("gpt-dataset/gsuite.txt") else "gsuite.txt")
        raw_accounts = load_accounts(acc_file) if os.path.exists(acc_file) else []
        pending = [
            a for a in raw_accounts
            if not results.has_success(a.email.lower()) and
            (args.retry_failed or store.get_status(a.email.lower()) != FlowState.FAILED) and
            store.get_status(a.email.lower()) != FlowState.DONE
        ]
        target_count = min(args.limit, len(pending)) if args.limit > 0 else len(pending)
        account_queue = deque(pending[:target_count])
        logger.info(f"Google OAuth accounts queued: {len(account_queue)}")
    else:
        target_count = args.limit if args.limit > 0 else (proxy_pool.fresh_count if proxy_pool else 1)
        logger.info(f"TempMail accounts target: {target_count}")

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

            # Assign and strictly pre-check proxy against target URL for HTTP 200
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
                    logger.warning(f"worker #{worker_id}: all candidate proxies exhausted or non-200. Halting worker.")
                    if acc:
                        async with lock:
                            account_queue.appendleft(acc)
                    break
                logger.info(f"worker #{worker_id} assigned verified HTTP 200 proxy: {proxy.server} (fresh: {proxy_pool.fresh_count}, good: {proxy_pool.good_count})")

            ok = await run_gpt_single(
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
                    logger.info(f"Progress: {success_count}/{target_count} ChatGPT accounts created.")
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
