#!/usr/bin/env python3
"""
LLM7.io Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on LLM7.io using TempMail-Pro (6-digit OTP verification) or Google OAuth,
solves Cloudflare Turnstile, generates 5-year API keys, and saves tokens to apikey-llm7io.txt.
"""

import argparse
import asyncio
from collections import deque
from datetime import datetime, timedelta
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Dict, Any
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
    perform_google_oauth,
)

DEFAULT_SIGNUP_URL = "https://dash.llm7.io/"
API_KEYS_URL = "https://dash.llm7.io/#/api-keys"


class SmartProxyPool:
    """Manages proxy allocation with intelligent failure handling and success reuse."""

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
            addr = self.address_of(p)
            if addr not in self.bad_addresses:
                return p

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
    password: Optional[str],
    recovery_email: Optional[str],
    auth_method: str,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    temp_mail: TempMailClient,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
) -> bool:
    logger.info(
        f"starting LLM7.io registration for {email} "
        f"(auth={auth_method}, proxy={proxy.server if proxy else 'direct'}, pace={pace})"
    )
    store.upsert(
        {
            "email": email,
            "password": password,
            "authMethod": auth_method,
            "status": FlowState.PENDING,
            "proxy": proxy.server if proxy else None,
        }
    )

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
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            # Log active anonymous fingerprint
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(
                    f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | UA={fp.get('ua')}"
                )

            # ── 1. Navigate to LLM7.io ───────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(1500 * delay_mult), int(2800 * delay_mult))

            # ── 2. Check if already authenticated / landed on dashboard ──────
            is_dashboard = False
            for _ in range(3):
                if await page.query_selector(
                    "aside.dashboard-sidebar, button:has-text('API Keys'), button.dashboard-nav-logout, .dashboard-root"
                ):
                    is_dashboard = True
                    break
                await asyncio.sleep(0.5)

            if is_dashboard:
                logger.info("already authenticated and landed on LLM7.io dashboard!")
            else:
                # ── 3. Authenticate based on chosen auth_method ──────────────
                store.upsert({"email": email, "status": FlowState.SIGNUP})

                if auth_method == "google":
                    logger.info("initiating Google OAuth flow...")
                    # Ensure terms checkbox is checked if present
                    try:
                        terms_box = await page.query_selector("button[role='checkbox'].ios-green-checkbox")
                        if terms_box and await terms_box.get_attribute("data-state") != "checked":
                            await terms_box.click()
                            await human_delay(300, 600)
                    except Exception:
                        pass

                    google_btn = await page.wait_for_selector(
                        "#google-signin-button, div.S9gUrf-YoZ4jf, button:has-text('Lanjutkan dengan Google'), button:has-text('Continue with Google')",
                        timeout=15000,
                    )
                    if not google_btn:
                        raise RuntimeError("Could not find Google Sign-in button on LLM7.io")

                    await google_btn.click()
                    await human_delay(1200, 2200)

                    # Solve Turnstile if challenged during Google login redirect
                    await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                    logger.info("performing Google OAuth credentials entry...")
                    post_auth_page = await perform_google_oauth(
                        page=page,
                        email=email,
                        password=password or "",
                        recovery_email=recovery_email,
                        timeout_sec=65,
                        logger=logger,
                    )
                    page = post_auth_page
                    await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

                else:
                    # ── TempMail Flow (6-digit OTP verification) ───────────────
                    logger.info("filling email into signup form...")

                    # Ensure terms checkbox is checked
                    try:
                        terms_box = await page.query_selector("button[role='checkbox'].ios-green-checkbox")
                        if terms_box and await terms_box.get_attribute("data-state") != "checked":
                            await terms_box.click()
                            await human_delay(300, 600)
                    except Exception:
                        pass

                    email_input = await page.wait_for_selector(
                        "input#email-address, input.email-auth-input[type='email'], input[type='email']",
                        timeout=15000,
                    )
                    if not email_input:
                        raise RuntimeError("Could not find email input on LLM7.io signup page")

                    await human_type(
                        page,
                        "input#email-address, input.email-auth-input[type='email'], input[type='email']",
                        email,
                        min_delay_ms=45,
                        max_delay_ms=105,
                    )

                    # Dispatch standard events to ensure React state captures the email
                    await page.evaluate(
                        """(val) => {
                            const inp = document.querySelector('input#email-address, input.email-auth-input[type="email"]');
                            if (inp) {
                                inp.value = val;
                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }""",
                        email,
                    )
                    await human_delay(int(800 * delay_mult), int(1500 * delay_mult))

                    # Click "Continue with email"
                    submit_btn = await page.wait_for_selector(
                        "button:has-text('Continue with email')",
                        timeout=10000,
                    )
                    if not submit_btn:
                        raise RuntimeError("Could not find 'Continue with email' button")

                    logger.info("clicking 'Continue with email' button...")
                    await submit_btn.click()
                    await human_delay(1500, 2500)

                    # Wait for OTP form step
                    store.upsert({"email": email, "status": "WAIT_OTP"})
                    logger.info("waiting for OTP verification screen...")
                    otp_screen = await page.wait_for_selector(
                        "input#email-verification-code, p#email-verification-delivery, .email-verification-form",
                        timeout=15000,
                    )
                    if not otp_screen:
                        raise RuntimeError("Did not navigate to OTP verification form")

                    # Poll TempMail inbox for 6-digit OTP code
                    logger.info("polling TempMail inbox for 6-digit verification code from LLM7.io...")
                    otp_code = await temp_mail.wait_for_verification_otp(
                        address=email,
                        timeout_sec=75,
                        interval_sec=3.0,
                        filter_sender="",
                        code_pattern=re.compile(r"Your verification code is:[^\d]*(\d{6})", re.I),
                    )
                    logger.info(f"🔑 6-digit OTP received: {otp_code}")
                    store.upsert({"email": email, "status": "OTP_RECEIVED", "otp": otp_code})

                    # Input OTP into #email-verification-code
                    otp_input = await page.wait_for_selector(
                        "input#email-verification-code, input.email-verification-code",
                        timeout=10000,
                    )
                    if not otp_input:
                        raise RuntimeError("Could not find OTP input field")

                    await human_type(
                        page,
                        "input#email-verification-code, input.email-verification-code",
                        otp_code,
                        min_delay_ms=60,
                        max_delay_ms=120,
                    )
                    await page.evaluate(
                        """(val) => {
                            const inp = document.querySelector('input#email-verification-code, input.email-verification-code');
                            if (inp) {
                                inp.value = val;
                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                inp.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }""",
                        otp_code,
                    )
                    await human_delay(int(600 * delay_mult), int(1200 * delay_mult))

                    # Solve Cloudflare Turnstile if present on the OTP page
                    logger.info("checking and resolving Cloudflare Turnstile on OTP form...")
                    await resolve_turnstile_if_present(page, timeout_sec=25, logger=logger)
                    await human_delay(1000, 2000)

                    # Wait for "Verify email" button to become enabled
                    verify_btn = None
                    for _ in range(30):
                        btn = await page.query_selector("button:has-text('Verify email')")
                        if btn:
                            is_disabled = await btn.get_attribute("disabled")
                            if is_disabled is None:
                                verify_btn = btn
                                break
                        # If still disabled, re-check turnstile
                        if not verify_btn and await page.query_selector(".turnstile-widget"):
                            await resolve_turnstile_if_present(page, timeout_sec=4, logger=None)
                        await asyncio.sleep(0.5)

                    if not verify_btn:
                        verify_btn = await page.query_selector("button:has-text('Verify email')")

                    if not verify_btn:
                        raise RuntimeError("Could not find 'Verify email' button")

                    logger.info("clicking 'Verify email' button...")
                    await verify_btn.click()
                    await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

                # ── 4. Confirm landing on LLM7.io dashboard ───────────────────
                logger.info("waiting for LLM7.io dashboard to mount...")
                dashboard_mounted = False
                for _ in range(40):
                    if await page.query_selector(
                        "aside.dashboard-sidebar, button:has-text('API Keys'), button.dashboard-nav-logout, .dashboard-root"
                    ):
                        dashboard_mounted = True
                        break
                    # Check for sonner error toasts
                    err_toast = await page.query_selector("[data-sonner-toast][data-type='error']")
                    if err_toast:
                        err_text = await err_toast.text_content()
                        raise RuntimeError(f"LLM7.io returned error: {err_text}")
                    await asyncio.sleep(0.5)

                if not dashboard_mounted:
                    raise RuntimeError("Did not land on LLM7.io dashboard after verification")

            store.upsert({"email": email, "status": FlowState.DASHBOARD})
            logger.info("successfully landed on LLM7.io dashboard!")

            # ── 5. Navigate to API Keys section ───────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            logger.info("navigating to API Keys page...")

            # Click API Keys nav button or navigate to #/api-keys
            api_keys_nav = await page.query_selector("button:has-text('API Keys'), a[href*='api-keys']")
            if api_keys_nav:
                await api_keys_nav.click()
                await human_delay(int(1200 * delay_mult), int(2200 * delay_mult))

            if "#/api-keys" not in page.url:
                await page.goto(API_KEYS_URL, wait_until="domcontentloaded")
                await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))

            # Optional: Dismiss warning notification banner if present
            try:
                warn_dismiss = await page.query_selector("button.api-key-warning-dismiss")
                if warn_dismiss:
                    await warn_dismiss.click()
                    await human_delay(300, 600)
            except Exception:
                pass

            # ── 6. Open "Add API key" Modal ───────────────────────────────────
            add_key_btn = await page.wait_for_selector(
                "button.token-add-button, button:has-text('Add API key')",
                timeout=15000,
            )
            if not add_key_btn:
                raise RuntimeError("Could not find 'Add API key' button on API Keys page")

            logger.info("clicking 'Add API key' button...")
            await add_key_btn.click()
            await human_delay(int(800 * delay_mult), int(1500 * delay_mult))

            # Wait for modal dialog
            modal = await page.wait_for_selector("div[role='dialog']", timeout=10000)
            if not modal:
                raise RuntimeError("Add API key modal dialog did not appear")

            # ── 7. Configure Token Name and 5-Year Expiration ─────────────────
            token_name = f"key-{random.randint(10000, 99999)}"
            logger.info(f"entering token name: '{token_name}'...")
            await human_type(
                page,
                "div[role='dialog'] input[placeholder='Token name'], div[role='dialog'] input.token-form-input[type='text']",
                token_name,
                min_delay_ms=40,
                max_delay_ms=90,
            )
            await page.evaluate(
                """(val) => {
                    const inp = document.querySelector("div[role='dialog'] input[placeholder='Token name']");
                    if (inp) {
                        inp.value = val;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }""",
                token_name,
            )
            await human_delay(400, 800)

            # Calculate 5 years from current date
            now = datetime.now()
            try:
                future_date = now.replace(year=now.year + 5)
            except ValueError:
                future_date = now + timedelta(days=365 * 5)
            expiry_str = future_date.strftime("%Y-%m-%dT%H:%M")
            logger.info(f"setting token expiration to 5 years: {expiry_str}...")

            await page.evaluate(
                """(val) => {
                    const inp = document.querySelector("div[role='dialog'] input[type='datetime-local']");
                    if (inp) {
                        inp.value = val;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }""",
                expiry_str,
            )
            await human_delay(int(600 * delay_mult), int(1200 * delay_mult))

            # ── 8. Submit and Extract Created API Key ──────────────────────────
            create_btn = await page.wait_for_selector(
                "div[role='dialog'] button[type='submit']:has-text('Create'), div[role='dialog'] button:has-text('Create')",
                timeout=5000,
            )
            if not create_btn:
                raise RuntimeError("Could not find 'Create' button inside modal")

            logger.info("submitting API key creation form...")
            await create_btn.click()
            await human_delay(1500, 2500)

            # Wait for success modal ("Token Created")
            logger.info("waiting for Token Created success modal...")
            token_el = await page.wait_for_selector(
                ".modal-token-value, div[role='dialog'] .modal-token-value",
                timeout=15000,
            )
            if not token_el:
                raise RuntimeError("Could not find generated token value in success modal")

            api_key = (await token_el.text_content() or "").strip()
            if not api_key or len(api_key) < 10:
                raise RuntimeError(f"Extracted token appears invalid or empty: '{api_key}'")

            logger.info(f"🎉 Generated API Key: {api_key[:12]}...{api_key[-8:]} (Length: {len(api_key)})")

            # Dismiss success modal cleanly
            try:
                done_btn = await page.query_selector("div[role='dialog'] button:has-text('Done')")
                if done_btn:
                    await done_btn.click()
                    await human_delay(400, 800)
            except Exception:
                pass

            # ── 9. Save Results ──────────────────────────────────────────────
            results.mark_success(email=email, password=password or "tempmail", api_key=api_key)
            store.upsert({"email": email, "password": password, "status": FlowState.DONE, "apiKey": api_key})
            logger.info(f"saved API key to apikey-llm7io.txt and akun-result-llm7io.txt successfully!")
            return True

    except Exception as e:
        err_msg = str(e)
        logger.error(f"registration failed for {email}: {err_msg}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": err_msg})
        results.mark_failed(email=email, password_or_reason=err_msg)

        # Save debug screenshot on failure
        if browser_ctx:
            try:
                async with browser_ctx as b:
                    for p in b.contexts[0].pages if b.contexts else []:
                        ss_path = os.path.join(screenshot_dir, f"{sanitized_email}_error.png")
                        await p.screenshot(path=ss_path, full_page=True)
                        logger.info(f"debug screenshot saved to {ss_path}")
                        break
            except Exception:
                pass
        return False
    finally:
        kill_descendant_processes()


async def main():
    parser = argparse.ArgumentParser(description="LLM7.io Automation Runner (Camoufox)")
    parser.add_argument("--auth", choices=["tempmail", "google"], default="tempmail", help="Auth method (default: tempmail)")
    parser.add_argument("--headed", action="store_true", help="Run browser with visible UI")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode (default)")
    parser.add_argument("--no-proxy", action="store_true", help="Do not use proxies (direct machine connection)")
    parser.add_argument("--proxy-file", default="", help="Specific proxy file to use")
    parser.add_argument("--reuse-proxy", action="store_true", help="Rotate and reuse proxies across accounts")
    parser.add_argument("--accounts-file", default="", help="Accounts file for Google OAuth (default: gsuite.txt)")
    parser.add_argument("--domain", default="ifqy.net", help="TempMail domain (default: ifqy.net)")
    parser.add_argument("--state-file", default="state-llm7io.jsonl", help="State file path")
    parser.add_argument("--output-file", default="apikey-llm7io.txt", help="API key output file")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay in seconds between accounts")
    parser.add_argument("--limit", type=int, default=0, help="Max accounts to process (0 = all)")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default="human", help="Pacing mode")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate setup without launching browser")
    parser.add_argument("--workers", type=int, default=1, help="Concurrent workers (default: 1)")

    args = parser.parse_args()
    logger = create_logger("llm7io")
    setup_process_signals()

    headed = args.headed and not args.headless

    # Paths and stores
    state_file = os.path.join(REPO_ROOT, args.state_file) if not os.path.isabs(args.state_file) else args.state_file
    key_file = os.path.join(REPO_ROOT, args.output_file) if not os.path.isabs(args.output_file) else args.output_file
    result_success_file = os.path.join(REPO_ROOT, "akun-result-llm7io.txt")
    result_failed_file = os.path.join(REPO_ROOT, "akun-failed-llm7io.txt")
    screenshot_dir = os.path.join(REPO_ROOT, "screenshots-llm7io")

    store = JsonlStore(state_file)
    results = ResultWriter(
        key_files=[key_file],
        account_result_file=result_success_file,
        account_failed_file=result_failed_file,
    )
    temp_mail = TempMailClient(default_domain=args.domain)

    # Proxies
    proxies: List[Proxy] = []
    if not args.no_proxy:
        proxy_file = args.proxy_file
        if not proxy_file:
            candidates = [os.path.join(REPO_ROOT, "proxy-live.txt"), os.path.join(REPO_ROOT, "proxy.txt")]
            for c in candidates:
                if os.path.exists(c):
                    proxy_file = c
                    break
        if proxy_file and os.path.exists(proxy_file):
            proxies = load_proxies(proxy_file)
            logger.info(f"loaded {len(proxies)} proxies from {proxy_file}")
        else:
            logger.warn("no proxy file found; running in direct connection mode")

    proxy_pool = SmartProxyPool(proxies) if proxies else None

    logger.info(
        f"LLM7.io runner configured: auth={args.auth}, headed={headed}, "
        f"proxies={len(proxies)}, limit={args.limit}, domain={args.domain}, pace={args.pace}"
    )

    if args.dry_run:
        logger.info("dry-run complete. Exiting without launching browser.")
        return

    # Accounts preparation
    accounts: List[Account] = []
    if args.auth == "google":
        acc_file = args.accounts_file
        if not acc_file:
            candidates = [
                os.path.join(REPO_ROOT, "gsuite.txt"),
                os.path.join(REPO_ROOT, "llm7io-dataset", "gsuite.txt"),
            ]
            for c in candidates:
                if os.path.exists(c):
                    acc_file = c
                    break
        if not acc_file or not os.path.exists(acc_file):
            logger.error("no accounts file found for Google OAuth (gsuite.txt is required)")
            sys.exit(1)

        accounts = load_accounts(acc_file)
        logger.info(f"loaded {len(accounts)} Google accounts from {acc_file}")

        # Filter already completed
        done_emails = results.get_successful_emails() | store.get_all_done_emails()
        pending_accounts = [a for a in accounts if a.email.lower() not in done_emails]
        if not args.retry_failed:
            failed_emails = store.get_all_failed_emails()
            pending_accounts = [a for a in pending_accounts if a.email.lower() not in failed_emails]

        logger.info(f"{len(pending_accounts)} Google accounts remaining to process")
        if not pending_accounts:
            logger.info("all Google accounts already completed!")
            return

        target_count = args.limit if args.limit > 0 else len(pending_accounts)
        items_to_run = pending_accounts[:target_count]

        for idx, acc in enumerate(items_to_run, 1):
            proxy = proxy_pool.get_next_proxy() if proxy_pool else None
            logger.info(f"[{idx}/{len(items_to_run)}] processing {acc.email}")

            success = await run_single_account(
                email=acc.email,
                password=acc.password,
                recovery_email=acc.recovery_email,
                auth_method="google",
                proxy=proxy,
                store=store,
                results=results,
                temp_mail=temp_mail,
                headed=headed,
                screenshot_dir=screenshot_dir,
                logger=logger,
                pace=args.pace,
            )

            if proxy_pool and proxy:
                proxy_pool.mark_result(proxy, success)

            if idx < len(items_to_run) and args.delay > 0:
                logger.info(f"waiting {args.delay}s delay before next account...")
                await asyncio.sleep(args.delay)

    else:
        # TempMail batch loop
        target_count = args.limit if args.limit > 0 else 1
        logger.info(f"starting TempMail generation for {target_count} account(s)...")

        processed = 0
        success_count = 0

        while processed < target_count:
            processed += 1
            logger.info(f"[{processed}/{target_count}] creating disposable TempMail address...")

            try:
                temp_acc = temp_mail.create_email(domain=args.domain)
                email = temp_acc.get("email")
                if not email:
                    raise RuntimeError("TempMail did not return email address")
            except Exception as e:
                logger.error(f"failed to generate TempMail: {e}")
                if processed < target_count:
                    await asyncio.sleep(args.delay)
                continue

            proxy = proxy_pool.get_next_proxy() if proxy_pool else None

            success = await run_single_account(
                email=email,
                password=None,
                recovery_email=None,
                auth_method="tempmail",
                proxy=proxy,
                store=store,
                results=results,
                temp_mail=temp_mail,
                headed=headed,
                screenshot_dir=screenshot_dir,
                logger=logger,
                pace=args.pace,
            )

            if success:
                success_count += 1

            if proxy_pool and proxy:
                proxy_pool.mark_result(proxy, success)

            if processed < target_count and args.delay > 0:
                logger.info(f"waiting {args.delay}s delay before next account...")
                await asyncio.sleep(args.delay)

        logger.info(f"all finished! Successfully generated {success_count}/{target_count} accounts/keys.")


if __name__ == "__main__":
    asyncio.run(main())
