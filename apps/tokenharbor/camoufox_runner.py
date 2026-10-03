#!/usr/bin/env python3
"""
TokenHarbor Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on TokenHarbor using TempMail-Pro, verifies email, enables free models,
creates API keys, and saves tokens.
"""

import argparse
import asyncio
from collections import deque
import os
import random
import re
import sys
import time
from typing import Optional, List, Set
from urllib.parse import urlparse

# Ensure repo root is on sys.path so packages.camoufox_core can be imported
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from packages.camoufox_core import (
    launch_camoufox,
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
)

API_KEY_RE = re.compile(r"thk_(?:live_)?[A-Za-z0-9_\-]{20,}")
VERIFY_LINK_RE = re.compile(r"https://tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-]+")

DEFAULT_SIGNUP_URL = "https://tokenharbor.ai/login?mode=signup"
DASHBOARD_URL = "https://tokenharbor.ai/dashboard"
API_KEYS_URL = "https://tokenharbor.ai/dashboard/api-keys"

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
    logger.info(f"starting TokenHarbor signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    delay_mult = 1.4 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

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

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # Dismiss analytics/cookie banner if present
            try:
                cookie_btn = await page.query_selector('button:has-text("Accept analytics"), button:has-text("Essential only")')
                if cookie_btn:
                    await cookie_btn.click()
                    await human_delay(600, 1200)
            except Exception:
                pass

            # Simulate natural human mouse movement on landing
            try:
                viewport = page.viewport_size or {"width": 1280, "height": 800}
                await page.mouse.move(viewport["width"] // 2 + random.randint(-40, 40), random.randint(220, 380))
            except Exception:
                pass

            # ── 2. Fill Signup Form (Human Pacing) ──────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.SIGNUP})
            logger.info("filling email and password with human cadence...")

            await human_delay(int(800 * delay_mult), int(1500 * delay_mult))

            # Type email with realistic keystrokes
            await human_type(
                page,
                'input[name="email"], input[autocomplete="email"], input[type="email"]',
                email,
                min_delay_ms=50,
                max_delay_ms=115,
            )

            # Natural human pause between email and password (reading / moving focus)
            await human_delay(int(1500 * delay_mult), int(2600 * delay_mult))

            # Type password with realistic keystrokes
            await human_type(
                page,
                'input[name="password"], input[autocomplete="new-password"], input[type="password"]',
                password,
                min_delay_ms=55,
                max_delay_ms=120,
            )

            # Natural human hesitation/verification before clicking submit (4.0 - 6.0s)
            # This prevents TokenHarbor's "You're doing that a bit fast — take a breath" anti-bot warning
            logger.info("pausing naturally before submit (human verification)...")
            await human_delay(int(4000 * delay_mult), int(6000 * delay_mult))

            # Submit signup
            submit_btn = await page.wait_for_selector(
                'button[type="submit"][data-analytics="login-signup"], button[data-analytics="login-signup"], button[type="submit"]',
                timeout=12000,
            )
            if not submit_btn:
                if "/dashboard" not in page.url:
                    raise RuntimeError("Create account submit button not found")

            # Move mouse smoothly over submit button
            try:
                box = await submit_btn.bounding_box()
                if box:
                    await page.mouse.move(
                        box["x"] + box["width"] * random.uniform(0.3, 0.7),
                        box["y"] + box["height"] * random.uniform(0.3, 0.7),
                        steps=random.randint(6, 14),
                    )
                    await human_delay(300, 700)
            except Exception:
                pass

            logger.info("clicking Create account submit button...")
            await submit_btn.click()

            # Resolve Turnstile if challenged
            await resolve_turnstile_if_present(page, timeout_sec=12, logger=logger)

            # Check for immediate warning / error or dashboard redirect
            logger.info("waiting for response or dashboard transition...")
            signup_error = None
            for _ in range(30):  # poll for up to ~15 seconds
                if "/dashboard" in page.url:
                    break

                error_msg = await page.evaluate("""() => {
                    // Check dedicated form error paragraph (Next.js server action result container)
                    const errEl = document.querySelector('form p[data-bordered="true"], form p.border, [role="alert"], .text-destructive, .text-red-500, .text-red-600');
                    if (errEl && errEl.textContent) {
                        const t = errEl.textContent.trim();
                        if (t && !/sending|checking|one moment/i.test(t)) return t;
                    }
                    // Broader check for any alert/warning container
                    const allEls = document.querySelectorAll('form p, form div, [role="alert"], p');
                    const warningPattern = /couldn['’]t create your account|team has been alerted|not supported|take a breath|doing that a bit fast|too many attempts|slow down|support@tokenharbor\\.ai|try again in a minute|invalid email|already registered/i;
                    for (const el of allEls) {
                        const t = el.textContent ? el.textContent.trim() : "";
                        if (t && warningPattern.test(t)) {
                            return t;
                        }
                    }
                    return null;
                }""")

                if error_msg:
                    signup_error = error_msg
                    break

                await asyncio.sleep(0.5)

            if signup_error:
                logger.warn(f"TokenHarbor warning/error detected: '{signup_error}'. Skipping account immediately to switch to different IP...")
                raise RuntimeError(f"Signup rejected: {signup_error}")

            if "/dashboard" not in page.url:
                raise RuntimeError(f"Signup timed out without reaching /dashboard (current URL: {page.url})")

            store.upsert({"email": email, "status": FlowState.DASHBOARD})
            await human_delay(2000, 3500)

            # ── 3. Enable Free Models ───────────────────────────────────────
            logger.info("checking Enable free models consent...")
            try:
                free_btn = await page.wait_for_selector(
                    'button[data-analytics="freemodel-consent-enable"], button:has-text("Enable free models")',
                    timeout=5000,
                )
                if free_btn:
                    logger.info("clicking Enable free models button...")
                    await free_btn.click()
                    await human_delay(1000, 2000)
            except Exception:
                pass

            # ── 4. Trigger Email Verification ───────────────────────────────
            store.upsert({"email": email, "status": FlowState.TRIGGER_VERIFY})
            logger.info("checking Verify email banner on dashboard...")
            try:
                verify_btn = await page.wait_for_selector(
                    'button:has-text("Verify email")',
                    timeout=8000,
                )
                if verify_btn:
                    logger.info("clicking Verify email button...")
                    await verify_btn.click()
                    await human_delay(1500, 2500)
            except Exception:
                logger.info("Verify email button not found, may have auto-triggered")

            # ── 5. Poll TempMail for Verification Link ──────────────────────
            logger.info("waiting for verification email from TempMail...")
            verify_url = await temp_mail.wait_for_verification_link(
                address=email,
                timeout_sec=75,
                interval_sec=2.5,
                filter_sender="tokenharbor",
                link_pattern=VERIFY_LINK_RE,
            )
            logger.info(f"verification URL received: {verify_url}")

            store.upsert({"email": email, "status": FlowState.EMAIL_VERIFIED, "verificationLink": verify_url})
            logger.info("navigating to verification URL...")
            await page.goto(verify_url, wait_until="domcontentloaded")
            await human_delay(2500, 4000)

            # ── 6. Create API Key ───────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            logger.info(f"navigating to {API_KEYS_URL}...")
            await page.goto(API_KEYS_URL, wait_until="domcontentloaded")
            await human_delay(1500, 2500)

            # Click "+ New key" button
            new_key_btn = await page.wait_for_selector(
                'button:has-text("+ New key"), button:has-text("New key")',
                timeout=15000,
            )
            if not new_key_btn:
                raise RuntimeError("+ New key button not found on API keys page")
            await new_key_btn.click()
            await human_delay(800, 1500)

            # Type label
            label = f"App-{email.split('@')[0][:8]}-{random.randint(10, 99)}"
            logger.info(f"typing key label: {label}...")
            await human_type(
                page,
                'input[placeholder*="Cursor, Production"], input.input-float[type="text"], input[type="text"]',
                label,
            )
            await human_delay(500, 1000)

            # Click "Create key" submit
            create_btn = await page.wait_for_selector(
                'button:has-text("Create key")',
                timeout=10000,
            )
            if not create_btn:
                raise RuntimeError("Create key submit button not found")
            await create_btn.click()
            await human_delay(2000, 3500)

            # Extract generated API key
            logger.info("extracting generated API key...")
            api_key = None
            for _ in range(20):
                text = await page.evaluate("""() => {
                    const el = document.querySelector('code.input-float, code');
                    if (el && el.textContent) return el.textContent;
                    return document.body.innerText;
                }""")
                match = API_KEY_RE.search(text)
                if match:
                    api_key = match.group(0)
                    break
                await asyncio.sleep(0.5)

            if not api_key:
                # Capture debug screenshot
                ss_path = os.path.join(screenshot_dir, f"apikey_extract_failed_{sanitized_email}.png")
                await page.screenshot(path=ss_path)
                raise RuntimeError(f"API key not found after creation; saved debug screenshot to {ss_path}")

            logger.info(f"SUCCESS: API key extracted -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        return False

async def main_async():
    parser = argparse.ArgumentParser(description="TokenHarbor Camoufox runner (TempMail + Camoufox)")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed (visible) mode")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--proxy-file", default=None, help="Path to proxy list file")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between accounts in seconds")
    parser.add_argument("--retry-failed", action="store_true", help="Retry accounts previously marked failed")
    parser.add_argument("--state-file", default="state-tokenharbor.jsonl", help="State file")
    parser.add_argument("--output-file", default="apikey-tokenharbor.txt", help="API key output file")
    parser.add_argument("--limit", type=int, default=1, help="Max accounts to process (default: 1)")
    parser.add_argument("--password", default=os.getenv("TOKENHARBOR_PASSWORD", "torabikA1###########"), help="Account password")
    parser.add_argument("--domain", default=os.getenv("TEMPMAIL_DOMAIN", "ifqy.net"), help="TempMail domain")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default=os.getenv("PACE", "human"), help="Typing cadence and interaction pace")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-tokenharbor", help="Directory for failure screenshots")
    args = parser.parse_args()

    # Resolve proxies file
    proxy_file = args.proxy_file
    if not proxy_file and not args.no_proxy:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    # Resolve output files
    key_files = ["apikey-tokenharbor.txt"]
    if args.output_file and args.output_file not in key_files:
        key_files.append(args.output_file)

    proxies = load_proxies(proxy_file) if (proxy_file and not args.no_proxy) else []
    temp_mail = TempMailClient(default_domain=args.domain)

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file="akun-result-tokenharbor.txt",
        account_failed_file="akun-failed-tokenharbor.txt",
    )

    logger = create_logger()
    logger.info(f"TokenHarbor Camoufox runner started (pace={args.pace}). Proxies loaded: {len(proxies)} (proxy_mode={'no-proxy' if args.no_proxy or not proxies else 'active'})")

    if args.dry_run:
        logger.info("dry-run: config validated (no browser launched)")
        return

    proxy_pool = SmartProxyPool(proxies) if proxies else None
    count = args.limit if args.limit > 0 else (len(proxies) if proxies else 1)
    logger.info(f"Planning to process target {count} account(s) using domain @{args.domain}")

    processed = 0
    success_count = 0
    max_total_attempts = max(count * 4, len(proxies) * 2, 10) if proxies else count

    while success_count < count and processed < max_total_attempts:
        if not args.no_proxy and proxies:
            proxy = proxy_pool.get_next_proxy()
            if proxy is None:
                logger.warn(f"All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left.")
                break
            proxy_addr = proxy_pool.address_of(proxy)
            reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
            logger.info(f"Selected proxy: {proxy.server} ({proxy_addr}){reuse_tag}. (Fresh remaining: {len(proxy_pool.fresh_proxies)}, Good pool: {len(proxy_pool.good_proxies)})")
        else:
            proxy = None

        # Generate fresh TempMail account
        acc_data = temp_mail.create_email(domain=args.domain)
        email = acc_data["email"]
        password = args.password
        acc_logger = create_logger(email)

        ok = await run_single_account(
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

        processed += 1
        if proxy_pool and proxy:
            if ok:
                proxy_pool.mark_result(proxy, success=True)
                logger.info(f"Proxy {proxy.server} verified GOOD! Added to reusable proxy pool.")
            else:
                proxy_pool.mark_result(proxy, success=False)
                logger.warn(f"Proxy {proxy.server} failed/rejected. Discarded and will not be reused.")

        if ok:
            success_count += 1
            logger.info(f"Progress: {success_count}/{count} accounts completed successfully.")

        if success_count < count:
            if ok and args.delay > 0:
                logger.info(f"Waiting {args.delay}s before next account...")
                await asyncio.sleep(args.delay)
            elif not ok:
                logger.info("Switching immediately to next account with a fresh/different IP...")
                await asyncio.sleep(1.5)

    logger.info(f"TokenHarbor Camoufox batch finished: {success_count}/{count} target achieved ({processed} total attempts).")

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
