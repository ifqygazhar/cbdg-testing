#!/usr/bin/env python3
"""
TokenHarbor Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on TokenHarbor using either Google OAuth (GSuite) or TempMail-Pro,
verifies email, enables free models, creates API keys, and saves tokens.
"""

import argparse
import asyncio
from collections import deque, defaultdict
import html
import os
import random
import re
import sys
import time
from typing import Optional, List, Set
from urllib.parse import urlparse, parse_qs, unquote

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

API_KEY_RE = re.compile(r"thk_(?:live_)?[A-Za-z0-9_\-]{20,}")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+", re.IGNORECASE)

DEFAULT_SIGNUP_URL = "https://tokenharbor.ai/login?mode=signup"
DASHBOARD_URL = "https://tokenharbor.ai/dashboard"
API_KEYS_URL = "https://tokenharbor.ai/dashboard/api-keys"

class SmartProxyPool:
    """Manages proxy allocation with intelligent failure handling and success reuse.
    - Bad/rejected proxies are permanently discarded.
    - Successful proxies are preserved in a reusable pool and recycled when fresh proxies run out.
    - Every new attempt receives a distinct IP from the pool.
    """
    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies: deque[Proxy] = deque(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: Set[str] = set()
        self.reuse_proxy = reuse_proxy

    @staticmethod
    def address_of(proxy: Proxy) -> str:
        try:
            return urlparse(proxy.server).hostname or proxy.server
        except Exception:
            return proxy.server

    def get_next_proxy(self) -> Optional[Proxy]:
        # If reuse_proxy is active and we have proven good proxies, reuse good proxies first
        if self.reuse_proxy and self.good_proxies:
            p = self.good_proxies.pop(0)
            self.good_proxies.append(p)
            return p

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

async def check_something_snapped(page) -> bool:
    """Detect Next.js unhandled crash screen 'Something snapped.'"""
    try:
        return await page.evaluate("""() => {
            const h2 = document.querySelector('h2');
            if (h2 && /something snapped/i.test(h2.textContent || '')) return true;
            const p = document.querySelector('p');
            if (p && /hit an error we didn['’]t expect/i.test(p.textContent || '')) return true;
            return false;
        }""")
    except Exception:
        return False

async def recover_if_something_snapped(page, target_url: Optional[str] = None, logger = None) -> bool:
    """If 'Something snapped.' is shown, clicks 'Try again' or reloads target_url."""
    for attempt in range(1, 4):
        if not await check_something_snapped(page):
            return True

        if logger:
            logger.warn(f"'Something snapped.' error screen detected! (recovery attempt {attempt}/3)")

        # 1. Try clicking 'Try again' button
        try:
            btn = await page.query_selector('button:has-text("Try again"), button.bg-zinc-900')
            if btn:
                if logger:
                    logger.info("clicked 'Try again' button to recover...")
                await btn.click()
                await human_delay(2000, 3000)
                if not await check_something_snapped(page):
                    if logger:
                        logger.info("Successfully recovered from 'Something snapped' via button!")
                    return True
        except Exception:
            pass

        # 2. Reload or navigate back to target_url
        if await check_something_snapped(page):
            if logger:
                logger.info(f"reloading page / navigating to {target_url or 'current URL'}...")
            try:
                if target_url:
                    await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
                else:
                    await page.reload(wait_until="domcontentloaded", timeout=30000)
                await human_delay(2500, 3500)
                if not await check_something_snapped(page):
                    if logger:
                        logger.info("Successfully recovered from 'Something snapped' after reload!")
                    return True
            except Exception as e:
                if logger:
                    logger.warn(f"Reload failed: {e}")

    return not await check_something_snapped(page)

async def handle_finish_and_start_chatting(page, logger) -> bool:
    """
    Handles 'One more step' screen after Google OAuth signup (tokenharbor-dataset/oauth-finish-after-signup.html)
    """
    for _ in range(12):
        if "/dashboard" in page.url:
            return True
        try:
            finish_btn = await page.query_selector('button:has-text("Finish and start chatting"), button[type="submit"]:has-text("Finish and start chatting")')
            if finish_btn:
                logger.info("detected 'One more step' onboarding screen, clicking 'Finish and start chatting'...")
                await finish_btn.click()
                await human_delay(2000, 3500)
                return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False

async def dismiss_cookie_banner(page, logger=None) -> bool:
    """Dismisses cookie / analytics banner if present on screen."""
    try:
        cookie_btn = await page.query_selector(
            'button:has-text("Accept analytics"), button:has-text("Essential only"), button.btn-float-primary:has-text("Accept analytics")'
        )
        if cookie_btn and await cookie_btn.is_visible():
            if logger:
                logger.info("dismissing cookie consent banner...")
            try:
                await cookie_btn.click(timeout=2000)
            except Exception:
                await cookie_btn.click(force=True, timeout=2000)
            await asyncio.sleep(0.5)
            return True
    except Exception:
        pass
    return False

async def handle_enable_free_models_modal(page, logger=None, timeout_sec: int = 5) -> bool:
    """
    Detects and accepts the 'Enable free models?' modal dialog if present on dashboard.
    Ensures the dialog and backdrop are completely dismissed before proceeding.
    If the dialog is not present (e.g. account already enabled free models), returns cleanly.
    """
    try:
        free_btn = None
        try:
            free_btn = await page.wait_for_selector(
                'button[data-analytics="freemodel-consent-enable"], button:has-text("Enable free models")',
                timeout=timeout_sec * 1000,
                state="visible",
            )
        except Exception:
            free_btn = None

        if not free_btn:
            modal_h2 = await page.query_selector('h2:has-text("Enable free models")')
            if not modal_h2:
                if logger:
                    logger.info("no 'Enable free models?' modal popup detected (already enabled or not prompted).")
                return False

        if logger:
            logger.info("detected 'Enable free models?' modal popup, clicking 'Enable free models' button...")

        clicked = False
        if free_btn:
            try:
                await free_btn.click(timeout=3000)
                clicked = True
            except Exception:
                try:
                    await free_btn.click(force=True, timeout=2000)
                    clicked = True
                except Exception:
                    pass

        if not clicked:
            await page.evaluate("""() => {
                const btn = document.querySelector('button[data-analytics="freemodel-consent-enable"]') ||
                            Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Enable free models');
                if (btn) btn.click();
            }""")

        # Wait for the modal / button to completely close / detach
        try:
            await page.wait_for_selector(
                'button[data-analytics="freemodel-consent-enable"], h2:has-text("Enable free models")',
                state="hidden",
                timeout=6000,
            )
        except Exception:
            is_still_open = await page.evaluate("""() => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                };
                const btn = document.querySelector('button[data-analytics="freemodel-consent-enable"]');
                const h2 = Array.from(document.querySelectorAll('h2')).find(b => (b.textContent || '').includes('Enable free models'));
                return isVisible(btn) || isVisible(h2);
            }""")
            if is_still_open:
                if logger:
                    logger.warn("modal still open after click, attempting force JS click...")
                await page.evaluate("""() => {
                    const btn = document.querySelector('button[data-analytics="freemodel-consent-enable"]') ||
                                Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Enable free models');
                    if (btn) btn.click();
                }""")
                await asyncio.sleep(1.0)

        await human_delay(1000, 2000)
        await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)

        if logger:
            logger.info("Enable free models consent accepted and popup dismissed.")
        return True

    except Exception as e:
        if logger:
            logger.warn(f"error while handling Enable free models modal: {e}")
        return False


async def retrieve_verification_link_from_gmail(context, email: str, logger, timeout_sec: int = 65) -> Optional[str]:
    """
    Opens Gmail web (mail.google.com) in a new tab within the existing authenticated context,
    locates the Token Harbor verification email, and extracts the verification URL.
    """
    logger.info(f"opening Gmail (mail.google.com) in a new tab to retrieve TokenHarbor verification email for {email}...")
    gmail_page = None
    verify_url = None
    try:
        gmail_page = await context.new_page()
        gmail_page.set_default_timeout(35000)

        await gmail_page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded")
        await human_delay(2000, 3500)

        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            # Handle Workspace Terms speedbump if present
            if "speedbump" in gmail_page.url:
                accept_btn = await gmail_page.query_selector(
                    'button:has-text("I understand"), button:has-text("Saya mengerti"), button:has-text("Accept"), button:has-text("Setuju")'
                )
                if accept_btn:
                    logger.info("accepted Workspace Terms speedbump in Gmail tab...")
                    await accept_btn.click()
                    await human_delay(2000, 3500)

            # Handle account chooser if shown
            if "accounts.google.com" in gmail_page.url:
                acc_chooser = await gmail_page.query_selector(f'[data-identifier="{email}"]')
                if acc_chooser:
                    logger.info(f"clicking account chooser for {email}...")
                    await acc_chooser.click()
                    await human_delay(2000, 3500)

            # Dismiss any promo/onboarding popups
            try:
                dismiss_btn = await gmail_page.query_selector(
                    'button:has-text("Not now"), button:has-text("Dismiss"), button:has-text("Close"), div[role="button"]:has-text("Done")'
                )
                if dismiss_btn:
                    await dismiss_btn.click()
                    await human_delay(500, 1000)
            except Exception:
                pass

            # First, check if verify link is already in page content (e.g. preview / already opened)
            content = await gmail_page.content()
            m = VERIFY_LINK_RE.search(content)
            if m:
                raw_url = html.unescape(m.group(0))
                if "google.com/url" in raw_url:
                    parsed = urlparse(raw_url)
                    qs = parse_qs(parsed.query)
                    verify_url = qs.get("q", [raw_url])[0]
                else:
                    verify_url = raw_url
                logger.info(f"Token Harbor verification URL retrieved: {verify_url}")
                break

            # Look for Token Harbor email row in inbox
            email_row = await gmail_page.query_selector(
                'tr.zA:has-text("Token Harbor"), tr:has-text("Token Harbor"), div[role="row"]:has-text("Token Harbor"), tr:has-text("Verify your email")'
            )
            if email_row:
                logger.info("found Token Harbor email in Gmail inbox! Clicking to open...")
                await email_row.click()
                await human_delay(2000, 3500)

                # Look for link element in opened email
                try:
                    link_el = await gmail_page.wait_for_selector('a[href*="tokenharbor.ai/verify-email"]', timeout=10000)
                    if link_el:
                        raw_href = await link_el.get_attribute("href")
                        if raw_href:
                            raw_href = html.unescape(raw_href)
                            if "google.com/url" in raw_href:
                                parsed = urlparse(raw_href)
                                qs = parse_qs(parsed.query)
                                verify_url = qs.get("q", [raw_href])[0]
                            else:
                                verify_url = raw_href
                            logger.info(f"Token Harbor verification URL retrieved: {verify_url}")
                            break
                except Exception:
                    pass

                content = await gmail_page.content()
                m = VERIFY_LINK_RE.search(content)
                if m:
                    raw_url = html.unescape(m.group(0))
                    if "google.com/url" in raw_url:
                        parsed = urlparse(raw_url)
                        qs = parse_qs(parsed.query)
                        verify_url = qs.get("q", [raw_url])[0]
                    else:
                        verify_url = raw_url
                    logger.info(f"Token Harbor verification URL retrieved: {verify_url}")
                    break

            # Refresh inbox
            try:
                refresh_btn = await gmail_page.query_selector('div[aria-label*="Refresh" i], div[data-tooltip*="Refresh" i], div[act="20"]')
                if refresh_btn:
                    await refresh_btn.click()
                else:
                    await gmail_page.reload(wait_until="domcontentloaded")
            except Exception:
                pass

            await asyncio.sleep(4)

    except Exception as e:
        logger.warn(f"error while retrieving email from Gmail: {e}")
    finally:
        if gmail_page:
            try:
                await gmail_page.close()
            except Exception:
                pass

    return verify_url

async def create_and_extract_api_key(page, email: str, screenshot_dir: str, logger) -> str:
    """Navigates to API keys page, creates a new key, and extracts the generated token."""
    logger.info(f"navigating to {API_KEYS_URL}...")
    await page.goto(API_KEYS_URL, wait_until="domcontentloaded")
    await human_delay(1500, 2500)

    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    api_key = None

    for key_attempt in range(1, 4):
        await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)

        # Click "+ New key" button
        new_key_btn = await page.wait_for_selector(
            'button:has-text("+ New key"), button:has-text("New key")',
            timeout=15000,
        )
        if not new_key_btn:
            if await check_something_snapped(page):
                logger.warn("'Something snapped.' detected on API keys page! Retrying...")
                await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)
                continue
            raise RuntimeError("+ New key button not found on API keys page")
        await new_key_btn.click()
        await human_delay(800, 1500)

        # Type label
        label = f"App-{email.split('@')[0][:8]}-{random.randint(10, 99)}"
        logger.info(f"typing key label: {label}...")
        label_input = await page.wait_for_selector(
            'input[placeholder*="Cursor, Production"], input.input-float[type="text"], input[type="text"]',
            timeout=8000,
        )
        if not label_input:
            if await check_something_snapped(page):
                logger.warn("'Something snapped.' detected while opening key modal! Retrying...")
                await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)
                continue
            raise RuntimeError("API key label input not found")
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
            if await check_something_snapped(page):
                logger.warn("'Something snapped.' detected before create submit! Retrying...")
                await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)
                continue
            raise RuntimeError("Create key submit button not found")
        await create_btn.click()
        await human_delay(2000, 3500)

        # Extract generated API key
        logger.info("extracting generated API key...")
        for _ in range(20):
            if await check_something_snapped(page):
                break
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

        if api_key:
            break

        if await check_something_snapped(page):
            logger.warn("'Something snapped.' detected after creating key! Retrying key creation step...")
            await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)
            continue

        break

    if not api_key:
        ss_path = os.path.join(screenshot_dir, f"apikey_extract_failed_{sanitized_email}.png")
        await page.screenshot(path=ss_path)
        raise RuntimeError(f"API key not found after creation; saved debug screenshot to {ss_path}")

    return api_key

async def run_single_google_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
    mark_failed_on_error: bool = True,
) -> bool:
    email = account.email
    password = account.password

    # Absolute safeguard: if account already completed or has api key, NEVER rerun!
    if email.lower() in results.get_successful_emails() or store.is_done(email):
        logger.info(f"Safeguard: {email} is already completed / successful (API key exists). Skipping execution.")
        return True

    logger.info(f"starting TokenHarbor Google OAuth signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    delay_mult = 1.4 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

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

            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up / Dashboard ─────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))
            await recover_if_something_snapped(page, target_url=DEFAULT_SIGNUP_URL, logger=logger)

            # Dismiss analytics/cookie banner if present
            await dismiss_cookie_banner(page, logger=logger)

            if "/dashboard" not in page.url:
                # ── 2. Click Continue with Google ──────────────────────────
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                google_btn = await page.wait_for_selector(
                    'button:has-text("Continue with Google"), button[aria-label="Continue with Google"]',
                    timeout=20000,
                )
                if not google_btn:
                    raise RuntimeError("Button 'Continue with Google' not found")

                logger.info("clicking 'Continue with Google'...")
                await google_btn.click()
                await human_delay(1500, 2500)

                # Resolve Turnstile if presented before redirecting to Google
                solved = await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)
                if solved:
                    await human_delay(1500, 2500)
                    try:
                        if "accounts.google.com" not in page.url and await page.locator('button:has-text("Continue with Google")').count() > 0:
                            logger.info("Turnstile solved, ensuring SSO button clicked...")
                            await page.locator('button:has-text("Continue with Google")').first.click(timeout=3000)
                    except Exception:
                        pass

                # ── 3. Google OAuth Flow ───────────────────────────────────
                post_auth_page = await perform_google_oauth(
                    page=page,
                    email=account.email,
                    password=account.password,
                    recovery_email=account.recovery_email,
                    timeout_sec=60,
                    logger=logger,
                )
                page = post_auth_page
                await human_delay(2000, 3500)

                # Resolve Turnstile if present on callback
                await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

                # ── 4. Handle "One more step" / Finish and start chatting ───
                await handle_finish_and_start_chatting(page, logger)

            # ── 5. Ensure Reached Dashboard ────────────────────────────────
            reached_dashboard = False
            for _ in range(25):
                if "/dashboard" in page.url:
                    reached_dashboard = True
                    break
                if await page.query_selector('button:has-text("Finish and start chatting")'):
                    await handle_finish_and_start_chatting(page, logger)
                await asyncio.sleep(0.5)

            if not reached_dashboard and "/dashboard" not in page.url:
                await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                if "/dashboard" not in page.url:
                    logger.info("navigating explicitly to dashboard...")
                    await page.goto(DASHBOARD_URL, wait_until="domcontentloaded")
                    await human_delay(2000, 3500)

            store.upsert({"email": email, "status": FlowState.DASHBOARD})
            await human_delay(2000, 3000)

            # ── 6. Enable Free Models (Idempotent) ──────────────────────────
            logger.info("checking Enable free models consent modal...")
            await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
            await handle_enable_free_models_modal(page, logger=logger, timeout_sec=5)
            await dismiss_cookie_banner(page, logger=logger)

            # ── 7. Email Verification via Gmail (Idempotent) ───────────────
            store.upsert({"email": email, "status": FlowState.TRIGGER_VERIFY})
            await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)

            # Guarantee that free models modal and cookie banner are completely cleared before touching verification banner
            await handle_enable_free_models_modal(page, logger=logger, timeout_sec=2)
            await dismiss_cookie_banner(page, logger=logger)

            # Check if email verification banner is present
            needs_verification = await page.evaluate("""() => {
                const text = document.body.innerText || '';
                return text.includes("Verify your email") ||
                       text.includes("Send verification email");
            }""")

            verify_url = None
            if not needs_verification:
                logger.info("Email verification not required or already verified on dashboard.")
            else:
                logger.info("checking Verify email button on dashboard...")
                verify_clicked = False
                for _ in range(5):
                    try:
                        # Ensure no overlay or late popup is blocking
                        await handle_enable_free_models_modal(page, logger=logger, timeout_sec=1)
                        await dismiss_cookie_banner(page)

                        verify_btn = await page.query_selector(
                            'button.btn-float-primary:has-text("Verify email"), button:has-text("Verify email"), button:has-text("Send verification email"), button:has-text("Resend email")'
                        )
                        if verify_btn and await verify_btn.is_enabled():
                            btn_txt = (await verify_btn.text_content() or "").strip()
                            if "email sent" not in btn_txt.lower():
                                logger.info(f"clicking '{btn_txt}' button to trigger verification email...")
                                try:
                                    await verify_btn.click(timeout=3000)
                                except Exception:
                                    await verify_btn.click(force=True, timeout=2000)
                                verify_clicked = True
                                await human_delay(2000, 3500)
                                await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                                break
                            else:
                                logger.info("Verify email button is already in 'Email sent' state.")
                                verify_clicked = True
                                break
                    except Exception:
                        pass
                    await asyncio.sleep(1)

                if not verify_clicked:
                    logger.warn("could not click 'Verify email' button; checking if already sent...")

                # Wait briefly for email dispatch
                await human_delay(2000, 3500)

                verify_url = await retrieve_verification_link_from_gmail(context, email, logger, timeout_sec=65)
                if verify_url:
                    store.upsert({"email": email, "status": FlowState.EMAIL_VERIFIED, "verificationLink": verify_url})
                    logger.info(f"navigating to verification URL: {verify_url}...")
                    await page.goto(verify_url, wait_until="domcontentloaded")
                    await human_delay(2500, 4000)
                    await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                else:
                    logger.warn("no verification URL retrieved from Gmail; proceeding to generate API key...")

            # ── 8. Create API Key ───────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)

            logger.info(f"SUCCESS: API key extracted -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        if mark_failed_on_error:
            results.mark_failed(email, password, str(e))
        return False

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
    # Absolute safeguard: if account already completed or has api key, NEVER rerun!
    if email.lower() in results.get_successful_emails() or store.is_done(email):
        logger.info(f"Safeguard: {email} is already completed / successful (API key exists). Skipping execution.")
        return True

    logger.info(f"starting TokenHarbor signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    delay_mult = 1.4 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

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

            # Log active anonymous fingerprint for this process/worker
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))
            await recover_if_something_snapped(page, target_url=DEFAULT_SIGNUP_URL, logger=logger)

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

            # Natural human pause between email and password
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
            logger.info("pausing naturally before submit (human verification)...")
            await human_delay(int(4000 * delay_mult), int(6000 * delay_mult))

            # Submit signup
            submit_btn = await page.wait_for_selector(
                'button[type="submit"][data-analytics="login-signup"], button[data-analytics="login-signup"], button[type="submit"]',
                timeout=10000,
            )
            if not submit_btn:
                raise RuntimeError("Submit signup button not found")

            # Retry loop on speed limit warning ("take a breath and try again")
            max_submit_attempts = 3
            for attempt in range(1, max_submit_attempts + 1):
                logger.info(f"submitting signup form (attempt {attempt}/{max_submit_attempts})...")
                btn = await page.wait_for_selector(
                    'button[type="submit"][data-analytics="login-signup"], button[data-analytics="login-signup"], button[type="submit"]',
                    timeout=8000,
                )
                if btn:
                    await btn.click()
                await human_delay(1500, 2500)

                # Check if Cloudflare Turnstile popped up
                solved = await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)
                if solved:
                    await human_delay(1500, 2500)
                    # Re-click submit if still on login page
                    if "/dashboard" not in page.url and await page.query_selector('button[type="submit"]'):
                        logger.info("Turnstile completed, re-submitting form...")
                        r_btn = await page.query_selector('button[type="submit"]')
                        if r_btn:
                            await r_btn.click()
                            await human_delay(1500, 2500)

                # Check for dashboard redirect or speed warning
                speed_warning = None
                signup_error = None
                for _ in range(14):
                    if "/dashboard" in page.url:
                        break
                    found_err = await page.evaluate("""() => {
                        const el = document.querySelector('form p[data-bordered="true"], form p.border, [role="alert"], .text-destructive, .text-red-500');
                        return el ? (el.textContent || '').trim() : null;
                    }""")
                    if found_err:
                        if re.search(r"fast|breath|slow down|too many attempts", found_err, re.I):
                            speed_warning = found_err
                            break
                        elif not re.search(r"sending|checking|one moment", found_err, re.I):
                            signup_error = found_err
                            break
                    await asyncio.sleep(0.5)

                if "/dashboard" in page.url:
                    break

                if speed_warning:
                    if attempt < max_submit_attempts:
                        wait_sec = 12 + attempt * 4
                        logger.warn(f"Speed warning: '{speed_warning}'. Taking a breath (waiting {wait_sec}s) and retrying submit...")
                        await asyncio.sleep(wait_sec)
                        continue
                    else:
                        raise RuntimeError(f"Rate limited by TokenHarbor (speed check): {speed_warning}")

                if signup_error:
                    logger.warn(f"TokenHarbor error detected: '{signup_error}'. Skipping account immediately...")
                    raise RuntimeError(f"Signup rejected: {signup_error}")

                break

            # Confirm dashboard reached
            reached_dashboard = False
            for _ in range(25):
                if "/dashboard" in page.url:
                    reached_dashboard = True
                    break
                await asyncio.sleep(0.5)

            if not reached_dashboard and "/dashboard" not in page.url:
                await recover_if_something_snapped(page, target_url=DEFAULT_SIGNUP_URL, logger=logger)
                err_text = await page.evaluate("""() => {
                    const el = document.querySelector('form p[data-bordered="true"], form p.border, [role="alert"], .text-destructive, .text-red-500');
                    return el ? (el.textContent || '').trim() : null;
                }""")
                if err_text:
                    raise RuntimeError(f"Signup rejected: {err_text}")
                raise RuntimeError(f"Signup timed out without reaching /dashboard (current URL: {page.url})")

            store.upsert({"email": email, "status": FlowState.DASHBOARD})
            await human_delay(2000, 3500)

            # ── 3. Enable Free Models ───────────────────────────────────────
            logger.info("checking Enable free models consent modal...")
            await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
            await handle_enable_free_models_modal(page, logger=logger, timeout_sec=5)
            await dismiss_cookie_banner(page, logger=logger)

            # ── 4. Trigger Email Verification ───────────────────────────────
            store.upsert({"email": email, "status": FlowState.TRIGGER_VERIFY})
            logger.info("checking Verify email banner on dashboard...")
            await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
            await handle_enable_free_models_modal(page, logger=logger, timeout_sec=2)
            await dismiss_cookie_banner(page, logger=logger)
            try:
                verify_btn = await page.wait_for_selector(
                    'button.btn-float-primary:has-text("Verify email"), button:has-text("Verify email"), button:has-text("Send verification email")',
                    timeout=8000,
                )
                if verify_btn:
                    logger.info("clicking Verify email button...")
                    try:
                        await verify_btn.click(timeout=3000)
                    except Exception:
                        await verify_btn.click(force=True, timeout=2000)
                    await human_delay(1500, 2500)
                    await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
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
            await recover_if_something_snapped(page, target_url=verify_url, logger=logger)

            # ── 6. Create API Key ───────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)

            logger.info(f"SUCCESS: API key extracted -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        return False

def get_completed_emails(store: JsonlStore, results: ResultWriter, current_state_file: str) -> Set[str]:
    """
    Returns the unified set of all email addresses that have successfully completed TokenHarbor registration
    and obtained an API key, checked across all sources:
    1. akun-result-tokenharbor.txt (and any result files configured on results)
    2. Primary JsonlStore (status == FlowState.DONE)
    3. Fallback state files (state.jsonl, state-tokenharbor.jsonl)
    """
    completed: Set[str] = set()
    completed.update(results.get_successful_emails())
    completed.update(store.get_all_done_emails())

    for sf in ["state.jsonl", "state-tokenharbor.jsonl"]:
        if os.path.exists(sf) and os.path.abspath(sf) != os.path.abspath(current_state_file):
            try:
                alt = JsonlStore(sf)
                completed.update(alt.get_all_done_emails())
            except Exception:
                pass

    return completed

def get_failed_emails(store: JsonlStore, results: ResultWriter, current_state_file: str) -> Set[str]:
    failed: Set[str] = set()
    failed.update(results.get_failed_emails())
    failed.update(store.get_all_failed_emails())

    for sf in ["state.jsonl", "state-tokenharbor.jsonl"]:
        if os.path.exists(sf) and os.path.abspath(sf) != os.path.abspath(current_state_file):
            try:
                alt = JsonlStore(sf)
                failed.update(alt.get_all_failed_emails())
            except Exception:
                pass

    return failed

async def main_async():
    parser = argparse.ArgumentParser(description="TokenHarbor Camoufox runner (Google OAuth / TempMail + Camoufox)")
    parser.add_argument("--auth", choices=["tempmail", "google"], default=os.getenv("TOKENHARBOR_AUTH", "tempmail"), help="Auth method: tempmail or google (default: tempmail)")
    parser.add_argument("--accounts-file", default="", help="Path to gsuite accounts file (required if --auth google)")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed (visible) mode")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--proxy-file", default=None, help="Path to proxy list file")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between accounts in seconds")
    parser.add_argument("--retry-failed", action="store_true", help="Retry accounts previously marked failed")
    parser.add_argument("--state-file", default=os.getenv("TOKENHARBOR_STATE_FILE") or os.getenv("STATE_FILE") or ("state.jsonl" if os.path.exists("state.jsonl") else "state-tokenharbor.jsonl"), help="State file")
    parser.add_argument("--output-file", default="apikey-tokenharbor.txt", help="API key output file")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Number of parallel workers")
    parser.add_argument("--limit", type=int, default=0, help="Max accounts to process")
    parser.add_argument("--password", default=os.getenv("TOKENHARBOR_PASSWORD", "torabikA1###########"), help="Account password (for tempmail)")
    parser.add_argument("--domain", default=os.getenv("TEMPMAIL_DOMAIN", "ifqy.net"), help="TempMail domain")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default=os.getenv("PACE", "human"), help="Cadence pace")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-tokenharbor", help="Directory for failure screenshots")
    parser.add_argument("--reuse-proxy", action="store_true", default=os.getenv("PROXY_REUSE", "0") in ("1", "true", "yes"), help="Prioritize/reuse verified good proxies")
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
    proxy_pool = SmartProxyPool(proxies, reuse_proxy=args.reuse_proxy) if proxies else None

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file="akun-result-tokenharbor.txt",
        account_failed_file="akun-failed-tokenharbor.txt",
    )

    logger = create_logger()
    logger.info(f"TokenHarbor Camoufox runner started (auth={args.auth}, pace={args.pace}, workers={args.workers}). Proxies loaded: {len(proxies)} (proxy_mode={'no-proxy' if args.no_proxy or not proxies else 'active'})")

    # ── GOOGLE OAUTH FLOW ───────────────────────────────────────────────────
    if args.auth == "google":
        accounts_file = args.accounts_file
        if not accounts_file:
            if os.path.exists("tokenharbor-dataset/gsuite.txt"):
                accounts_file = "tokenharbor-dataset/gsuite.txt"
            elif os.path.exists("gsuite.txt"):
                accounts_file = "gsuite.txt"
            else:
                logger.error("No accounts file found for Google OAuth (checked tokenharbor-dataset/gsuite.txt and gsuite.txt)")
                sys.exit(1)

        accounts = load_accounts(accounts_file)
        logger.info(f"Loaded {len(accounts)} Google accounts from {accounts_file}")

        completed_emails = get_completed_emails(store, results, args.state_file)
        failed_emails = get_failed_emails(store, results, args.state_file)

        # Strictly exclude ANY account that has already completed successfully!
        eligible_accounts = [
            acc for acc in accounts
            if acc.email.lower() not in completed_emails
        ]

        if not args.retry_failed:
            eligible_accounts = [
                acc for acc in eligible_accounts
                if acc.email.lower() not in failed_emails
                and not store.is_restricted_or_banned(acc.email)
            ]
        else:
            logger.info("Retry mode active: prioritizing previously failed accounts at the front of the queue.")
            def sort_key(acc):
                return 0 if acc.email.lower() in failed_emails else 1
            eligible_accounts.sort(key=sort_key)

        if not eligible_accounts:
            logger.info("All accounts have already been completed successfully! Nothing to do.")
            return

        target_count = min(args.limit, len(eligible_accounts)) if args.limit > 0 else len(eligible_accounts)
        worker_count = max(1, min(args.workers, target_count, len(eligible_accounts)))
        if args.limit > 0 and args.limit > len(eligible_accounts):
            logger.warn(
                f"Limit yang diminta ({args.limit} akun) melebihi sisa akun yang tersedia ({len(eligible_accounts)} akun). "
                f"Target otomatis disesuaikan menjadi {target_count} akun agar akun yang sudah selesai tidak diulang."
            )

        logger.info(
            f"Account queue stats: total={len(accounts)}, completed={len(accounts) - len(eligible_accounts)}, "
            f"todo={len(eligible_accounts)}, target={target_count}, workers={worker_count}, retry_failed={args.retry_failed}"
        )

        if args.dry_run:
            logger.info(f"dry-run: next account(s) to process: {[a.email for a in eligible_accounts[:target_count]]}")
            return

        account_queue = deque(eligible_accounts)
        attempts_per_account = defaultdict(int)
        MAX_PROXY_ATTEMPTS = 3 if proxy_pool else 1
        max_total_attempts = max(target_count * 4, len(proxies) * 2, 15) if proxy_pool else (len(eligible_accounts) * 2)

        processed = 0
        success_count = 0
        in_flight = 0
        lock = asyncio.Lock()

        async def google_worker(worker_id: int):
            nonlocal processed, success_count, in_flight
            while True:
                account = None
                proxy = None
                async with lock:
                    if success_count >= target_count:
                        break
                    if processed >= max_total_attempts:
                        logger.warn(f"Worker #{worker_id}: Max attempt limit reached ({processed}/{max_total_attempts}).")
                        break

                    if not account_queue:
                        if in_flight == 0:
                            break
                    else:
                        account = account_queue.popleft()
                        in_flight += 1

                        if not args.no_proxy and proxies:
                            proxy = proxy_pool.get_next_proxy()
                            if proxy is None:
                                logger.warn(
                                    f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left."
                                )
                                account_queue.appendleft(account)
                                in_flight -= 1
                                break
                            proxy_addr = proxy_pool.address_of(proxy)
                            reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                            logger.info(
                                f"Worker #{worker_id} selected proxy: {proxy.server} ({proxy_addr}){reuse_tag}. "
                                f"(Fresh remaining: {len(proxy_pool.fresh_proxies)}, Good pool: {len(proxy_pool.good_proxies)})"
                            )
                        else:
                            proxy = None

                        processed += 1

                if account is None:
                    # In-flight workers might re-queue an account
                    await asyncio.sleep(1.0)
                    continue

                acc_logger = create_logger(f"w{worker_id}:{account.email}")
                will_retry_if_failed = (
                    proxy_pool is not None
                    and proxy_pool.has_proxies
                    and attempts_per_account[account.email] < MAX_PROXY_ATTEMPTS - 1
                )
                ok = await run_single_google_account(
                    account=account,
                    proxy=proxy,
                    store=store,
                    results=results,
                    headed=args.headed,
                    screenshot_dir=args.screenshot_dir,
                    logger=acc_logger,
                    pace=args.pace,
                    mark_failed_on_error=(not will_retry_if_failed),
                )

                async with lock:
                    in_flight -= 1
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
                    else:
                        attempts_per_account[account.email] += 1
                        current_att = attempts_per_account[account.email]
                        can_retry_with_diff_proxy = (
                            proxy_pool is not None
                            and proxy_pool.has_proxies
                            and current_att < MAX_PROXY_ATTEMPTS
                            and success_count < target_count
                        )
                        if can_retry_with_diff_proxy:
                            logger.info(
                                f"Worker #{worker_id}: Proxy failed for {account.email}. "
                                f"Skipping bad proxy and re-queuing account to retry with fresh/different proxy (attempt {current_att + 1}/{MAX_PROXY_ATTEMPTS})..."
                            )
                            account_queue.append(account)
                        else:
                            if proxy_pool and current_att >= MAX_PROXY_ATTEMPTS:
                                logger.warn(f"Worker #{worker_id}: Account {account.email} exhausted all {MAX_PROXY_ATTEMPTS} proxy attempts. Marked as failed.")
                            results.mark_failed(account.email, account.password, "Proxy/automation failure")

                if success_count < target_count:
                    if ok and args.delay > 0:
                        logger.info(f"Worker #{worker_id} waiting {args.delay}s before next account...")
                        await asyncio.sleep(args.delay)
                    elif not ok:
                        logger.info(f"Worker #{worker_id} switching immediately to next proxy / account...")
                        await asyncio.sleep(1.5)

        if worker_count > 1:
            await asyncio.gather(*(google_worker(i + 1) for i in range(worker_count)))
        else:
            await google_worker(1)

        logger.info(f"TokenHarbor Camoufox Google batch finished: {success_count}/{target_count} target achieved ({processed} total attempts).")
        return

    # ── TEMPMAIL FLOW ───────────────────────────────────────────────────────
    temp_mail = TempMailClient(default_domain=args.domain)
    count = args.limit if args.limit > 0 else (len(proxies) if proxies else 1)
    worker_count = max(1, min(args.workers, count))
    logger.info(f"Planning to process target {count} account(s) using domain @{args.domain} with {worker_count} parallel worker(s)")

    if args.dry_run:
        logger.info("dry-run: TempMail config validated (no browser launched)")
        return

    processed = 0
    success_count = 0
    max_total_attempts = max(count * 4, len(proxies) * 2, 10) if proxies else count
    lock = asyncio.Lock()

    async def worker(worker_id: int):
        nonlocal processed, success_count
        while True:
            proxy = None
            async with lock:
                if success_count >= count or processed >= max_total_attempts:
                    break

                if not args.no_proxy and proxies:
                    proxy = proxy_pool.get_next_proxy()
                    if proxy is None:
                        logger.warn(f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left.")
                        break
                    proxy_addr = proxy_pool.address_of(proxy)
                    reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                    logger.info(f"Worker #{worker_id} selected proxy: {proxy.server} ({proxy_addr}){reuse_tag}. (Fresh remaining: {len(proxy_pool.fresh_proxies)}, Good pool: {len(proxy_pool.good_proxies)})")
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
                    logger.info(f"Progress: {success_count}/{count} accounts completed successfully.")

            if success_count < count:
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
