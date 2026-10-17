#!/usr/bin/env python3
"""
TokenHarbor Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on TokenHarbor using either Google OAuth (GSuite) or TempMail-Pro,
verifies email, enables free models, creates API keys, and saves tokens.
"""

from __future__ import annotations
import argparse
import asyncio
from collections import deque, defaultdict
import concurrent.futures
import html
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Tuple, Union, Dict, Any
from urllib.parse import urlparse, parse_qs, unquote
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
    read_emails_from_result_file,
    load_already_registered_accounts,
    create_logger,
    setup_process_signals,
    kill_descendant_processes,
    cleanup_leftover_browser_processes,
    cleanup_temp_profiles,
    get_vps_system_status,
    safe_close_browser,
    TempMailClient,
    resolve_turnstile_if_present,
    find_turnstile_sitekey,
    solve_turnstile_via_api,
    setup_turnstile_interceptor,
    inject_turnstile_token,
    perform_google_oauth,
    GooglePhoneVerificationException,
)
from packages.camoufox_core.turnstile import find_turnstile_target

class TurnstileDetectedException(Exception):
    """Raised when Cloudflare Turnstile captcha is detected when using proxy."""
    pass

async def is_turnstile_detected(page, logger=None) -> bool:
    """Checks if Cloudflare Turnstile widget or challenge iframe is currently present."""
    try:
        target = await find_turnstile_target(page)
        if target:
            if logger:
                sk_info = await find_turnstile_sitekey(page)
                if sk_info:
                    logger.info(f"🔑 Cloudflare Turnstile Sitekey: {sk_info[0]} (sumber: {sk_info[1]})")
            return True
        if await page.locator("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']").count() > 0:
            if logger:
                sk_info = await find_turnstile_sitekey(page)
                if sk_info:
                    logger.info(f"🔑 Cloudflare Turnstile Sitekey: {sk_info[0]} (sumber: {sk_info[1]})")
            return True
        content = (await page.content() or "").lower()
        if "challenges.cloudflare.com" in content and ("cf-turnstile" in content or "turnstile" in content):
            if logger:
                sk_info = await find_turnstile_sitekey(page)
                if sk_info:
                    logger.info(f"🔑 Cloudflare Turnstile Sitekey: {sk_info[0]} (sumber: {sk_info[1]})")
            return True
        if "just a moment..." in content and "cloudflare" in content:
            return True
    except Exception:
        pass
    return False

API_KEY_RE = re.compile(r"thk_(?:live_)?[A-Za-z0-9_\-]{20,}")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+", re.IGNORECASE)

DEFAULT_SIGNUP_URL = "https://tokenharbor.ai/login?mode=signup"
DEFAULT_LOGIN_URL = "https://tokenharbor.ai/login"
DASHBOARD_URL = "https://tokenharbor.ai/dashboard"
API_KEYS_URL = "https://tokenharbor.ai/dashboard/api-keys"

def is_dashboard_url(url: str) -> bool:
    """Checks whether the URL path legitimately points to the TokenHarbor dashboard."""
    if not url:
        return False
    try:
        parsed = urlparse(url)
        # Note: /oauth/finish with ?next=/dashboard is onboarding, NOT the dashboard!
        return (parsed.path == "/dashboard" or parsed.path.startswith("/dashboard/")) and "/oauth/finish" not in parsed.path
    except Exception:
        return False

def is_onboarding_url(url: str) -> bool:
    """Checks whether the URL is the TokenHarbor onboarding / finish screen."""
    if not url:
        return False
    try:
        parsed = urlparse(url)
        return "/oauth/finish" in parsed.path
    except Exception:
        return False

def check_proxy_single_sync(
    proxy: Proxy,
    target_url: str = DEFAULT_SIGNUP_URL,
    timeout_sec: float = 6.0,
) -> Tuple[Proxy, bool, Union[int, str], float]:
    """
    Directly probes a proxy against TokenHarbor before opening the browser.
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
        connect_timeout = min(max(timeout_sec / 2, 2.0), 3.5)
        resp = requests.get(
            target_url,
            proxies=proxies,
            headers=headers,
            timeout=(connect_timeout, timeout_sec),
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
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    try:
        future_map = {
            executor.submit(check_proxy_single_sync, p, target_url, timeout_sec): p
            for p in candidates
        }
        done, not_done = concurrent.futures.wait(
            future_map.keys(),
            timeout=timeout_sec + 2.0,
        )
        results: List[Tuple[Proxy, bool, Union[int, str], float]] = []
        for f in done:
            try:
                results.append(f.result())
            except Exception as e:
                p = future_map[f]
                results.append((p, False, type(e).__name__, timeout_sec))
        for f in not_done:
            p = future_map[f]
            f.cancel()
            results.append((p, False, "batch_timeout", timeout_sec))
        return results
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

class SmartProxyPool:
    """Manages proxy allocation with intelligent failure handling and success reuse.
    - Bad/rejected proxies are permanently discarded.
    - Successful proxies are preserved in a reusable pool and recycled when fresh proxies run out.
    - Proactively probes candidate proxies against TokenHarbor before opening the browser.
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
        Asynchronously retrieves the next proxy that is guaranteed to return HTTP 200 on TokenHarbor.
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
                    f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against TokenHarbor (HTTP 200, timeout={timeout_sec}s)... "
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

async def check_onboarding_error(page) -> Optional[str]:
    """Checks for Sonner toasts, alerts, or rejection banners on onboarding screen."""
    try:
        return await page.evaluate("""() => {
            // 1. Sonner toast notifications
            const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'));
            for (const toast of toasts) {
                const title = toast.querySelector('[data-title]')?.textContent || '';
                const desc = toast.querySelector('[data-description]')?.textContent || '';
                const text = (title + ' ' + desc).trim() || toast.textContent?.trim() || '';
                if (text && !text.toLowerCase().includes('welcome')) return text;
            }
            // 2. Form errors or alerts
            const alert = document.querySelector('[role="alert"], .text-destructive, .text-red-500, .text-rose-500, form p.border, form p[data-bordered="true"]');
            if (alert) {
                const text = alert.textContent?.trim();
                if (text) return text;
            }
            // 3. Rejection / IP restriction text in body
            const bodyText = document.body?.innerText || '';
            if (bodyText.includes("Your IP or email provider is not supported")) {
                return "Your IP or email provider is not supported for Token Harbor accounts.";
            }
            if (bodyText.includes("Too many requests") || bodyText.includes("Rate limit")) {
                return "Rate limit / Too many requests detected on onboarding.";
            }
            return null;
        }""")
    except Exception:
        return None

async def handle_finish_and_start_chatting(page, logger) -> bool:
    """
    Handles 'One more step' onboarding screen after Google OAuth signup (tokenharbor.ai/oauth/finish).
    Returns True if onboarding screen was detected and completed (new registration), False if directly dashboard.
    """
    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
        return False

    saw_screen = False
    max_attempts = 4
    for attempt in range(max_attempts):
        current_url = page.url
        if is_dashboard_url(current_url) and not is_onboarding_url(current_url):
            return saw_screen

        try:
            await dismiss_cookie_banner(page)
        except Exception:
            pass

        # Check for Cloudflare Turnstile if present on onboarding
        try:
            if await is_turnstile_detected(page, logger=logger):
                await resolve_turnstile_if_present(page, timeout_sec=10, logger=logger)
        except Exception:
            pass

        try:
            finish_btn = await page.query_selector(
                'button:has-text("Finish and start chatting"), button[type="submit"]:has-text("Finish and start chatting"), button[type="submit"]:has-text("Finish")'
            )
            is_finish_page = is_onboarding_url(current_url)
            if not finish_btn and is_finish_page:
                finish_btn = await page.query_selector('form button[type="submit"], button.rounded-full.bg-foreground')

            if finish_btn or is_finish_page:
                saw_screen = True

                # Check if there's an error on the screen before submit
                existing_err = await check_onboarding_error(page)
                if existing_err:
                    logger.warn(f"Onboarding error detected on screen: '{existing_err}'")
                    if "not supported" in existing_err.lower() or "too many requests" in existing_err.lower() or "rate limit" in existing_err.lower():
                        raise RuntimeError(f"Signup rejected: {existing_err}")

                logger.info(f"detected 'One more step' onboarding screen (Akun Baru, URL: {current_url}), attempting submit #{attempt+1}...")

                # Check if button is currently in pending/loading state
                btn_state = await page.evaluate("""() => {
                    const btn = document.querySelector('form button[type="submit"]') ||
                                Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Finish'));
                    if (!btn) return null;
                    return {
                        disabled: btn.disabled || btn.hasAttribute('disabled') || btn.classList.contains('disabled'),
                        loading: btn.getAttribute('aria-busy') === 'true' || !!btn.querySelector('.animate-spin') || (btn.textContent || '').includes('Loading'),
                        text: btn.textContent?.trim() || ''
                    };
                }""")

                if btn_state and (btn_state.get('loading') or btn_state.get('disabled')):
                    logger.info("Submit button is currently in pending/loading state, waiting for completion...")
                else:
                    # 1. Standard button click
                    try:
                        if finish_btn and await finish_btn.is_visible():
                            await finish_btn.scroll_into_view_if_needed(timeout=2000)
                            await finish_btn.click(timeout=4000)
                    except Exception as e:
                        logger.warn(f"Standard click on finish button failed: {e}")

                    # 2. Form requestSubmit (direct Server Action dispatch)
                    try:
                        await page.evaluate("""() => {
                            const form = document.querySelector('form');
                            if (form) {
                                try {
                                    form.requestSubmit();
                                } catch (e) {
                                    const btn = form.querySelector('button[type="submit"]') || document.querySelector('button.rounded-full');
                                    if (btn) btn.click();
                                }
                            }
                        }""")
                    except Exception as e:
                        logger.warn(f"Form requestSubmit failed: {e}")

                    # 3. Press Enter on invite_code input
                    try:
                        input_el = await page.query_selector('input[name="invite_code"]')
                        if input_el:
                            await input_el.focus()
                            await page.keyboard.press("Enter")
                    except Exception:
                        pass

                # Wait for transition to real dashboard (poll for 8 seconds)
                for _ in range(16):
                    await asyncio.sleep(0.5)
                    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                        logger.info("Successfully transitioned from 'One more step' onboarding to /dashboard!")
                        await human_delay(1500, 2500)
                        return True

                    # Check for Turnstile during submission
                    if await is_turnstile_detected(page):
                        logger.info("Turnstile detected during onboarding submit, resolving...")
                        await resolve_turnstile_if_present(page, timeout_sec=10, logger=logger)

                    # Check if error toast or alert appeared
                    submit_err = await check_onboarding_error(page)
                    if submit_err:
                        logger.warn(f"Onboarding error detected after submit: '{submit_err}'")
                        if "not supported" in submit_err.lower() or "too many requests" in submit_err.lower() or "rate limit" in submit_err.lower():
                            raise RuntimeError(f"Signup rejected: {submit_err}")

                # If still on onboarding: Test direct navigation to DASHBOARD_URL
                # Often the Server Action already updated the database session, and simply navigating to /dashboard will succeed!
                logger.info(f"Still on onboarding ({page.url}) after attempt #{attempt+1}. Testing direct navigation to {DASHBOARD_URL}...")
                try:
                    await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=15000)
                    await human_delay(1500, 2500)
                    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                        logger.info("Successfully reached /dashboard via direct navigation after onboarding submit!")
                        return True
                except Exception as e:
                    logger.warn(f"Direct dashboard navigation test failed: {e}")

                await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                    return True

                # If still on onboarding, reload page before next attempt to reset any stale form state
                if attempt < max_attempts - 1 and is_onboarding_url(page.url):
                    try:
                        logger.info("Reloading onboarding page to reset form state for next attempt...")
                        await page.reload(wait_until="domcontentloaded", timeout=15000)
                        await human_delay(1500, 2500)
                    except Exception:
                        pass
        except Exception as e:
            if "Signup rejected" in str(e):
                raise
            logger.warn(f"Error handling 'Finish and start chatting': {e}")

        await asyncio.sleep(0.5)

    return saw_screen

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

async def ensure_free_models_enabled(page, logger=None, timeout_sec: int = 8) -> bool:
    """
    Ensures free models are enabled:
    1. Checks for the modal popup on current page.
    2. If not found or after dismissal, checks for toggle switch in DOM.
    """
    handled_modal = await handle_enable_free_models_modal(page, logger=logger, timeout_sec=timeout_sec)
    await dismiss_cookie_banner(page, logger=logger)

    # Check for inline switch toggle if present on dashboard
    try:
        switch_btn = await page.query_selector(
            'button[role="switch"][aria-label*="free model" i], button[role="switch"]:has-text("Enable free models")'
        )
        if switch_btn:
            aria_checked = await switch_btn.get_attribute("aria-checked")
            if aria_checked != "true":
                if logger:
                    logger.info("Found toggle switch 'Enable free models' in state OFF (checked=false), clicking to toggle ON...")
                try:
                    await switch_btn.click(timeout=3000)
                except Exception:
                    await switch_btn.click(force=True, timeout=2000)
                await human_delay(1000, 2000)
                return True
    except Exception as e:
        if logger:
            logger.warn(f"Note checking toggle switch: {e}")

    return handled_modal

def verify_tokenharbor_key_api(api_key: str, timeout_sec: float = 8.0) -> Tuple[bool, int, str]:
    """
    Directly tests an API key against TokenHarbor /v1/chat/completions with deepseek-v4-flash:free.
    Returns (is_valid, http_status, message).
    is_valid is True only if status is 200.
    """
    if not api_key:
        return False, 0, "no_key"
    try:
        resp = requests.post(
            "https://tokenharbor.ai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-v4-flash:free",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 5,
            },
            timeout=timeout_sec,
        )
        if resp.status_code == 200:
            return True, 200, "ok"
        try:
            data = resp.json()
            err_msg = data.get("error", {}).get("message", f"HTTP_{resp.status_code}")
        except Exception:
            err_msg = f"HTTP_{resp.status_code}"
        return False, resp.status_code, err_msg
    except requests.exceptions.RequestException as e:
        return False, 0, str(e)



def extract_clean_verify_url(raw: str) -> str:
    """Extracts and unescapes TokenHarbor verification URL, resolving Google redirect wrappers."""
    if not raw:
        return ""
    clean = html.unescape(raw)
    if "google.com/url" in clean:
        try:
            parsed = urlparse(clean)
            qs = parse_qs(parsed.query)
            clean = qs.get("q", [clean])[0]
        except Exception:
            pass
    return clean

async def retrieve_verification_link_from_gmail(context, email: str, logger, timeout_sec: int = 90) -> Optional[str]:
    """
    Opens Gmail web (mail.google.com) in a new tab within the existing authenticated context,
    locates the Token Harbor verification email row in inbox, clicks to open the email detail view,
    clicks the 'Verify email' button inside the message, and returns the verification URL.
    """
    logger.info(f"opening Gmail (mail.google.com) in a new tab to retrieve TokenHarbor verification email for {email}...")
    gmail_page = None
    verify_url = None
    try:
        gmail_page = await context.new_page()
        gmail_page.set_default_timeout(60000)
        gmail_page.set_default_navigation_timeout(60000)

        await gmail_page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=60000)
        await human_delay(2000, 3500)

        start_time = time.time()
        reload_counter = 0
        while time.time() - start_time < timeout_sec:
            # Handle Google Speedbump / Workspace Terms of Service ("I understand", "Saya mengerti", "I agree", etc.)
            is_speedbump = bool(re.search(r"speedbump|termsofservice|tos|welcome", gmail_page.url, re.I))
            if is_speedbump:
                logger.info(f"detected Google Workspace Terms of Service speedbump ({gmail_page.url}) in Gmail tab, clicking 'I understand'...")
                try:
                    clicked_text = await gmail_page.evaluate("""() => {
                        const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                        const needles = [
                            'i understand', 'saya mengerti', 'i agree', 'saya setuju',
                            'accept all', 'accept', 'terima', 'continue', 'lanjutkan',
                            'confirm', 'agree', 'entiendo', "j'ai compris", 'ich verstehe'
                        ];
                        // 1. Check all buttons, role=button, and inputs
                        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
                        for (const btn of btns) {
                            const txt = norm(btn.textContent || btn.value || btn.getAttribute('aria-label'));
                            if (needles.some(n => txt.includes(n))) {
                                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                btn.focus();
                                btn.click();
                                return txt;
                            }
                        }
                        // 2. Google primary action button: button[jsname="LgbsSe"]
                        const lgbs = Array.from(document.querySelectorAll('button[jsname="LgbsSe"]')).filter(b => !b.disabled);
                        if (lgbs.length > 0) {
                            const btn = lgbs[lgbs.length - 1];
                            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                            btn.focus();
                            btn.click();
                            return norm(btn.textContent) || 'LgbsSe';
                        }
                        return null;
                    }""")
                    if clicked_text:
                        logger.info(f"successfully clicked Google speedbump button via DOM evaluate: '{clicked_text}'")
                        await human_delay(2000, 3500)
                        continue
                except Exception as e:
                    logger.warn(f"speedbump DOM evaluate click exception in Gmail tab: {e}")

                accept_btn = await gmail_page.query_selector(
                    'button:has-text("I understand"), button:has-text("Saya mengerti"), button:has-text("Accept"), button:has-text("Setuju")'
                )
                if accept_btn:
                    logger.info("accepted Workspace Terms speedbump in Gmail tab via selector...")
                    try:
                        await accept_btn.click(no_wait_after=True, timeout=10000)
                    except Exception:
                        await accept_btn.click(force=True, no_wait_after=True, timeout=5000)
                    await human_delay(2000, 3500)

            # Handle account chooser if shown
            if "accounts.google.com" in gmail_page.url:
                acc_chooser = await gmail_page.query_selector(f'[data-identifier="{email}"]')
                if acc_chooser:
                    logger.info(f"clicking account chooser for {email}...")
                    try:
                        await acc_chooser.click(no_wait_after=True, timeout=10000)
                    except Exception:
                        await acc_chooser.click(force=True, no_wait_after=True, timeout=5000)
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

            # ── Step A: Check if email detail view is currently open ─────────
            is_detail_open = await gmail_page.evaluate("""() => {
                const hash = window.location.hash || '';
                const hasThreadHash = hash.startsWith('#inbox/') && hash.length > 7;
                const heading = document.querySelector('h2.hP');
                const hasHeading = heading && (heading.textContent || '').includes('Verify your email');
                const verifyBtn = document.querySelector('a[href*="tokenharbor.ai/verify-email"]') ||
                                  Array.from(document.querySelectorAll('a')).find(a => (a.textContent || '').includes('Verify email'));
                const msgBody = document.querySelector('div.a3s');
                return Boolean(hasThreadHash || hasHeading || (msgBody && verifyBtn));
            }""")

            if is_detail_open:
                logger.info("detail tampilan email verifikasi Token Harbor terdeteksi terbuka di Gmail!")
                btn_link = None
                for _ in range(15):
                    btn_link = await gmail_page.query_selector('a:has-text("Verify email"), a[href*="tokenharbor.ai/verify-email"]')
                    if btn_link:
                        raw_href = await btn_link.get_attribute("href")
                        if raw_href:
                            verify_url = extract_clean_verify_url(raw_href)
                            if verify_url:
                                break
                    content = await gmail_page.content()
                    m = VERIFY_LINK_RE.search(content)
                    if m:
                        verify_url = extract_clean_verify_url(m.group(0))
                        if verify_url:
                            break
                    await asyncio.sleep(0.5)

                # Click the "Verify email" button inside the email body
                if btn_link:
                    logger.info("clicking 'Verify email' button inside Gmail message...")
                    try:
                        async with context.expect_page(timeout=4000) as popup_info:
                            await btn_link.click(timeout=3000)
                        popup = await popup_info.value
                        logger.info(f"Verification link opened popup tab: {popup.url}")
                        await popup.wait_for_load_state("domcontentloaded", timeout=15000)
                        if not verify_url and "verify-email" in popup.url:
                            verify_url = popup.url
                        await asyncio.sleep(2.5)
                        try:
                            await popup.close()
                        except Exception:
                            pass
                    except Exception:
                        try:
                            await btn_link.click(force=True, timeout=2000)
                        except Exception:
                            pass

                if verify_url:
                    logger.info(f"Token Harbor verification URL successfully retrieved: {verify_url}")
                    break
                else:
                    logger.warn("Detail view open but verify link not yet ready, retrying...")
                    await asyncio.sleep(1.5)
                    continue

            # ── Step B: If in inbox list, locate email row and click to open ───
            email_row = await gmail_page.query_selector(
                'tr.zA:has-text("Token Harbor"), tr.zA:has-text("Verify your email"), tr:has-text("Token Harbor"), div[role="row"]:has-text("Token Harbor")'
            )
            if email_row:
                logger.info("found Token Harbor email row in Gmail inbox! Clicking to open detail view...")
                # 1. Click specifically on the subject span / sender element
                subject_el = await email_row.query_selector('span.bog, td.y6, div.y6, span.bqe, span:has-text("Verify your email")')
                if subject_el:
                    try:
                        await subject_el.scroll_into_view_if_needed(timeout=3000)
                        await subject_el.click(timeout=4000)
                    except Exception:
                        pass

                # 2. Also dispatch DOM mouse events to ensure Gmail router triggers
                await gmail_page.evaluate("""() => {
                    const rows = Array.from(document.querySelectorAll('tr.zA, div[role="row"]'));
                    const row = rows.find(r => {
                        const txt = (r.innerText || '').toLowerCase();
                        return txt.includes('token harbor') || txt.includes('verify your email');
                    });
                    if (!row) return;
                    const el = row.querySelector('span.bog') || row.querySelector('div.y6') || row.querySelector('td.y6') || row.querySelector('span.bqe') || row;
                    try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e){}
                    try { el.click(); } catch(e){}
                    ['mouseenter', 'mousedown', 'mouseup', 'click'].forEach(name => {
                        try {
                            el.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true }));
                        } catch(e){}
                    });
                }""")

                # 3. Wait up to 8s for email detail view to open (do NOT reload while waiting)
                for _ in range(16):
                    await asyncio.sleep(0.5)
                    opened = await gmail_page.evaluate("""() => {
                        const hash = window.location.hash || '';
                        const hasThreadHash = hash.startsWith('#inbox/') && hash.length > 7;
                        const heading = document.querySelector('h2.hP');
                        const hasHeading = heading && (heading.textContent || '').includes('Verify your email');
                        const msgBody = document.querySelector('div.a3s');
                        return Boolean(hasThreadHash || hasHeading || msgBody);
                    }""")
                    if opened:
                        logger.info("Successfully entered Token Harbor email detail view!")
                        break

                # Detail view will be processed on the next loop iteration (Step A)
                continue

            # ── Step C: Email not visible yet in inbox: refresh or reload ─────
            reload_counter += 1
            try:
                refresh_btn = await gmail_page.query_selector('div[aria-label*="Refresh" i], div[data-tooltip*="Refresh" i], div[act="20"]')
                if refresh_btn and reload_counter % 3 != 0:
                    logger.info("Token Harbor email not visible yet; clicking Gmail refresh button...")
                    await refresh_btn.click()
                else:
                    logger.info("Token Harbor email not visible yet; reloading Gmail tab...")
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

async def check_account_has_existing_api_keys(page, logger=None) -> bool:
    """
    Checks if the account already has at least one API key on /dashboard/api-keys.
    Returns True if an existing key is detected, False otherwise.
    """
    try:
        if "/dashboard/api-keys" not in page.url:
            if logger:
                logger.info(f"checking if existing API keys exist at {API_KEYS_URL}...")
            await page.goto(API_KEYS_URL, wait_until="domcontentloaded", timeout=25000)
            await human_delay(1500, 2500)
        await recover_if_something_snapped(page, target_url=API_KEYS_URL, logger=logger)
        has_key = await page.evaluate("""() => {
            const text = document.body.innerText || '';
            if (text.includes("No keys yet")) return false;
            const items = document.querySelectorAll('ul.divide-y li, table tbody tr, button[aria-label*="delete"], button[aria-label*="copy"]');
            if (items.length > 0) return true;
            return text.includes("thk_live_") || text.includes("thk_");
        }""")
        return bool(has_key)
    except Exception as e:
        if logger:
            logger.warn(f"error checking existing API keys on page: {e}")
        return False

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
    gsuite_mode: str = "create_new_key",
) -> bool:
    email = account.email.strip()
    norm_email = email.lower()
    password = account.password

    # Absolute safeguard: if account already completed or has api key in ANY result file / state, NEVER rerun!
    require_key_for_safeguard = (gsuite_mode in ("create_new_key", "fetch_existing"))
    completed_lookup = get_completed_emails(store, results, getattr(store, "filepath", "state.jsonl"), require_api_key=require_key_for_safeguard)
    if norm_email in completed_lookup or store.is_done(email, require_api_key=require_key_for_safeguard) or store.is_done(norm_email, require_api_key=require_key_for_safeguard):
        status_tag = "memiliki API key valid" if require_key_for_safeguard else "sudah tercatat/terdaftar"
        logger.info(f"⏭️ [SAFEGUARD] Akun {email} {status_tag} di akun-result-tokenharbor.txt / state. Langsung dilewati tanpa membuka browser!")
        return True

    logger.info(f"starting TokenHarbor Google OAuth signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    delay_mult = 1.4 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

    browser_ctx = None
    active_browser = None
    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            active_browser = browser
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            timeout_ms = 90000 if proxy else 45000
            page.set_default_timeout(timeout_ms)
            page.set_default_navigation_timeout(timeout_ms)
            await setup_turnstile_interceptor(page)

            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up / Dashboard ─────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=timeout_ms)
            await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))
            await recover_if_something_snapped(page, target_url=DEFAULT_SIGNUP_URL, logger=logger)

            # Dismiss analytics/cookie banner if present
            await dismiss_cookie_banner(page, logger=logger)

            saw_onboarding = False
            if not is_dashboard_url(page.url):
                # Cek apakah landing page terblokir Turnstile (jika pakai proxy)
                if proxy and await is_turnstile_detected(page, logger=logger):
                    logger.warn(f"Cloudflare Turnstile captcha terdeteksi di landing page dengan proxy {proxy.server}! Langsung ganti proxy...")
                    raise TurnstileDetectedException(f"Turnstile detected on landing via proxy {proxy.server}")

                # ── 2. Click Continue with Google ──────────────────────────
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                google_btn = await page.wait_for_selector(
                    'button:has-text("Continue with Google"), button[aria-label="Continue with Google"]',
                    timeout=30000 if proxy else 20000,
                )
                if not google_btn:
                    raise RuntimeError("Button 'Continue with Google' not found")

                logger.info("clicking 'Continue with Google'...")
                try:
                    await google_btn.click(no_wait_after=True, timeout=15000)
                except Exception as e:
                    logger.warn(f"Standard click on SSO button failed ({e}), attempting JS click...")
                    await page.evaluate("""() => {
                        const btn = document.querySelector('button[aria-label="Continue with Google"]') ||
                                    Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Continue with Google'));
                        if (btn) btn.click();
                    }""")
                await human_delay(1500, 2500)

                # Deteksi Turnstile saat proses SSO Google (jika pakai proxy langsung ganti proxy)
                if proxy:
                    for _ in range(8):
                        if "accounts.google.com" in page.url or is_dashboard_url(page.url) or is_onboarding_url(page.url):
                            break
                        if await is_turnstile_detected(page, logger=logger):
                            logger.info(f"Cloudflare Turnstile captcha terdeteksi saat Google SSO dengan proxy {proxy.server}. Mencoba penyelesaian via Solver API & click...")
                            solved = await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)
                            if solved:
                                logger.info("Turnstile teratasi pada proses Google SSO!")
                                break
                            else:
                                logger.warn(f"Turnstile tidak teratasi dengan proxy {proxy.server}! Langsung ganti proxy...")
                                raise TurnstileDetectedException(f"Turnstile detected before Google OAuth via proxy {proxy.server}")
                        await asyncio.sleep(0.5)
                else:
                    solved = await resolve_turnstile_if_present(page, timeout_sec=25, logger=logger)
                    if solved:
                        await human_delay(1500, 2500)
                        try:
                            if "accounts.google.com" not in page.url and await page.locator('button:has-text("Continue with Google")').count() > 0:
                                logger.info("Turnstile solved, ensuring SSO button clicked...")
                                await page.locator('button:has-text("Continue with Google")').first.click(no_wait_after=True, timeout=5000)
                        except Exception:
                            pass

                # ── 3. Google OAuth Flow ───────────────────────────────────
                post_auth_page = await perform_google_oauth(
                    page=page,
                    email=account.email,
                    password=account.password,
                    recovery_email=account.recovery_email,
                    timeout_sec=120 if proxy else 75,
                    logger=logger,
                )
                page = post_auth_page
                await human_delay(2000, 3500)

                # Deteksi Turnstile pada callback OAuth TokenHarbor
                if proxy:
                    for _ in range(8):
                        if is_dashboard_url(page.url) or is_onboarding_url(page.url):
                            break
                        if await is_turnstile_detected(page, logger=logger):
                            logger.warn(f"Cloudflare Turnstile captcha terdeteksi di callback TokenHarbor dengan proxy {proxy.server}! Langsung ganti proxy...")
                            raise TurnstileDetectedException(f"Turnstile detected on callback via proxy {proxy.server}")
                        await asyncio.sleep(0.5)
                else:
                    await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

                # ── 4. Handle "One more step" / Finish and start chatting ───
                if await handle_finish_and_start_chatting(page, logger):
                    saw_onboarding = True

            # ── 5. Ensure Reached Dashboard ────────────────────────────────
            reached_dashboard = False
            for _ in range(12):
                if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                    reached_dashboard = True
                    break
                await asyncio.sleep(0.5)

            if not reached_dashboard and not is_dashboard_url(page.url):
                await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                if not (is_dashboard_url(page.url) and not is_onboarding_url(page.url)):
                    logger.info("navigating explicitly to dashboard...")
                    await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=20000)
                    await human_delay(2000, 3500)
                    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                        reached_dashboard = True
                    elif is_onboarding_url(page.url) or await page.query_selector('button:has-text("Finish and start chatting")'):
                        if await handle_finish_and_start_chatting(page, logger):
                            saw_onboarding = True
                            if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                                reached_dashboard = True

            if saw_onboarding:
                logger.info(f"✨ Akun {email}: Status REGISTRASI BARU (pertama kali mendaftar di TokenHarbor)")
            else:
                logger.info(f"🔑 Akun {email}: Status SUDAH TERDAFTAR SEBELUMNYA (login berhasil, lanjut mengambil/membuat API key)")

            store.upsert({"email": email, "status": FlowState.DASHBOARD, "is_new_registration": saw_onboarding})
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

            # ── Check GSuite Registration Strategy ─────────────────────────
            if gsuite_mode == "skip_existing":
                # Pastikan akun benar-benar sudah tiba di dashboard, bukan stuck di /oauth/finish
                if not (is_dashboard_url(page.url) and not is_onboarding_url(page.url)):
                    logger.warn(f"Akun {email} belum berada di dashboard (URL: {page.url}), tidak bisa diskip sebagai existing.")
                else:
                    has_existing_key = await check_account_has_existing_api_keys(page, logger=logger)
                    is_verified = not needs_verification
                    # Jika melihat onboarding (akun baru), JANGAN skip! Akun baru harus dibuatkan API key.
                    # Hanya skip jika onboarding TIDAK terlihat DAN (sudah punya API key ATAU sudah terverifikasi).
                    if not saw_onboarding and (has_existing_key or is_verified):
                        reasons = []
                        if has_existing_key:
                            reasons.append("sudah memiliki API key")
                        if is_verified:
                            reasons.append("akun sudah terverifikasi")
                        reason_desc = " & ".join(reasons) if reasons else "sudah terdaftar di server TokenHarbor"
                        logger.info(f"⏭️ Akun {email}: {reason_desc}. Sesuai opsi 'skip_existing', akun dilewati tanpa membuat API key baru!")
                        store.upsert({"email": email, "status": FlowState.DONE, "is_new_registration": False, "note": f"skipped_existing: {reason_desc}"})
                        results.mark_success(email=email, password=password, api_key="", extra="ALREADY_REGISTERED")
                        return True

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

                verify_url = await retrieve_verification_link_from_gmail(context, email, logger, timeout_sec=90 if proxy else 65)
                if verify_url:
                    store.upsert({"email": email, "status": FlowState.EMAIL_VERIFIED, "verificationLink": verify_url})
                    logger.info(f"navigating to verification URL: {verify_url}...")
                    await page.goto(verify_url, wait_until="domcontentloaded", timeout=timeout_ms)
                    await human_delay(2500, 4000)
                    await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
                else:
                    logger.warn("no verification URL retrieved from Gmail; proceeding to generate API key...")

            # ── 8. Create API Key ───────────────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)

            # ── 9. Validate API Key against TokenHarbor Completion API ──────
            is_valid, status_code, err_msg = verify_tokenharbor_key_api(api_key, timeout_sec=8.0)
            if not is_valid:
                is_verif_needed = ("verify your email" in err_msg.lower() or "confirmation link" in err_msg.lower() or "email_verification" in err_msg.lower())
                if status_code == 403 and is_verif_needed:
                    logger.warn(f"API key created ({api_key[:12]}...), but requires email verification! Attempting recovery via Gmail...")
                    recovery_url = await retrieve_verification_link_from_gmail(context, email, logger, timeout_sec=70 if proxy else 50)
                    if recovery_url:
                        logger.info(f"navigating to recovery verification URL: {recovery_url}...")
                        await page.goto(recovery_url, wait_until="domcontentloaded", timeout=timeout_ms)
                        await human_delay(3000, 5000)
                        verify_url = recovery_url
                        is_valid, status_code, err_msg = verify_tokenharbor_key_api(api_key, timeout_sec=8.0)

                if not is_valid:
                    raise RuntimeError(f"API key created but live API verification failed: HTTP {status_code} ({err_msg})")

            logger.info(f"SUCCESS: API key extracted & verified LIVE (HTTP 200 OK) -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            return True

    except GooglePhoneVerificationException as e:
        logger.error(f"Akun Google {email} meminta verifikasi nomor HP ({e}). Akun gagal dan dilewati tanpa retry!")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        raise
    except TurnstileDetectedException as e:
        logger.warn(f"Cloudflare Turnstile terdeteksi saat proses akun {email}: {e}. Membatalkan percobaan dan rotasi proxy...")
        raise
    except Exception as e:
        logger.error(f"failed: {e}")
        status_to_record = FlowState.PENDING if not mark_failed_on_error else FlowState.FAILED
        store.upsert({"email": email, "status": status_to_record, "error": str(e)})
        if mark_failed_on_error:
            results.mark_failed(email, password, str(e))
        return False
    finally:
        if active_browser:
            await safe_close_browser(active_browser)

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
    active_browser = None
    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            active_browser = browser
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            timeout_ms = 90000 if proxy else 45000
            page.set_default_timeout(timeout_ms)
            page.set_default_navigation_timeout(timeout_ms)
            await setup_turnstile_interceptor(page)

            # Log active anonymous fingerprint for this process/worker
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=timeout_ms)
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))
            await recover_if_something_snapped(page, target_url=DEFAULT_SIGNUP_URL, logger=logger)

            # Check and report Turnstile sitekey
            sk_info = await find_turnstile_sitekey(page)
            if sk_info:
                logger.info(f"🔑 Cloudflare Turnstile Sitekey terdeteksi: {sk_info[0]} (sumber: {sk_info[1]})")

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
                    try:
                        await btn.click(no_wait_after=True, timeout=10000)
                    except Exception:
                        await btn.click(force=True, no_wait_after=True, timeout=5000)
                await human_delay(1500, 2500)

                # Check if Cloudflare Turnstile popped up
                solved = await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)
                if solved:
                    await human_delay(1500, 2500)
                    # Re-click submit if still on login page
                    if not is_dashboard_url(page.url) and await page.query_selector('button[type="submit"]'):
                        logger.info("Turnstile completed, re-submitting form...")
                        r_btn = await page.query_selector('button[type="submit"]')
                        if r_btn:
                            try:
                                await r_btn.click(no_wait_after=True, timeout=10000)
                            except Exception:
                                await r_btn.click(force=True, no_wait_after=True, timeout=5000)
                            await human_delay(1500, 2500)

                # Check for dashboard redirect or speed warning
                speed_warning = None
                signup_error = None
                for _ in range(14):
                    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                        break
                    if is_onboarding_url(page.url) or await page.query_selector('button:has-text("Finish and start chatting")'):
                        await handle_finish_and_start_chatting(page, logger)
                        if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
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

                if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
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
                    if "human check" in signup_error.lower() or "captcha" in signup_error.lower() or "turnstile" in signup_error.lower():
                        logger.info(f"Human check required ('{signup_error}'). Meminta clearance token via Turnstile Solver API (bycf.snowping.cfd)...")
                        token = await solve_turnstile_via_api(page.url, "0x4AAAAAADBuC8Knz1EJZx9-", timeout_sec=20.0, logger=logger)
                        if token:
                            await inject_turnstile_token(page, token, logger=logger)
                            await human_delay(1500, 2500)
                            continue
                    logger.warn(f"TokenHarbor error detected: '{signup_error}'. Skipping account immediately...")
                    raise RuntimeError(f"Signup rejected: {signup_error}")

                break

            # Confirm dashboard reached
            reached_dashboard = False
            for _ in range(25):
                if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                    reached_dashboard = True
                    break
                if is_onboarding_url(page.url) or await page.query_selector('button:has-text("Finish and start chatting")'):
                    await handle_finish_and_start_chatting(page, logger)
                    if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                        reached_dashboard = True
                        break
                await asyncio.sleep(0.5)

            if not reached_dashboard and not is_dashboard_url(page.url):
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
                timeout_sec=120,
                interval_sec=2.5,
                filter_sender="tokenharbor",
                link_pattern=VERIFY_LINK_RE,
                target_domain="tokenharbor.ai",
                logger=logger,
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

            # ── 7. Validate API Key against TokenHarbor Completion API ──────
            is_valid, status_code, err_msg = verify_tokenharbor_key_api(api_key, timeout_sec=8.0)
            if not is_valid:
                raise RuntimeError(f"API key created but live API verification failed: HTTP {status_code} ({err_msg})")

            logger.info(f"SUCCESS: API key extracted & verified LIVE (HTTP 200 OK) -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "verificationLink": verify_url})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        return False
    finally:
        if active_browser:
            await safe_close_browser(active_browser)

class ReenableStore:
    def __init__(
        self,
        bad_file: str = "akun-bad-tokenharbor.txt",
        good_file: str = "akun-good-tokenharbor.txt",
        good_key_file: str = "apikey-good-tokenharbor.txt",
    ):
        self.bad_file = bad_file
        self.good_file = good_file
        self.good_key_file = good_key_file
        self.lock = asyncio.Lock()

    def _build_lookup_maps(self) -> Tuple[Dict[str, Tuple[str, str]], Dict[str, str]]:
        key_to_account: Dict[str, Tuple[str, str]] = {}
        email_to_password: Dict[str, str] = {}

        # 1. Gsuite files
        for gpath in ["tokenharbor-dataset/gsuite.txt", "gsuite.txt"]:
            if os.path.exists(gpath):
                try:
                    for acc in load_accounts(gpath):
                        email_to_password[acc.email.lower()] = acc.password
                except Exception:
                    pass

        # 2. Result & status files
        for rpath in [
            "akun-result-tokenharbor.txt",
            "akun-good-tokenharbor.txt",
            "akun-need-verif-tokenharbor.txt",
            "akun-bad-tokenharbor.txt",
        ]:
            if os.path.exists(rpath):
                try:
                    with open(rpath, "r", encoding="utf-8") as f:
                        for line in f:
                            raw = line.strip()
                            if not raw or raw.startswith("#"):
                                continue
                            parts = raw.split(":")
                            if len(parts) >= 3:
                                em = parts[0].strip()
                                k = parts[-1].strip()
                                pw = ":".join(parts[1:-1]).strip()
                                if k.startswith("thk_") or len(k) >= 25:
                                    key_to_account[k] = (em, pw)
                                    email_to_password[em.lower()] = pw
                except Exception:
                    pass

        # 3. State JSONL
        for spath in ["state.jsonl", "state-tokenharbor.jsonl"]:
            if os.path.exists(spath):
                try:
                    with open(spath, "r", encoding="utf-8") as f:
                        for line in f:
                            try:
                                obj = json.loads(line)
                                em = obj.get("email")
                                pw = obj.get("password")
                                k = obj.get("apiKey")
                                if em and pw:
                                    email_to_password[em.lower()] = pw
                                if k and em:
                                    key_to_account[k] = (em, pw or email_to_password.get(em.lower(), ""))
                            except Exception:
                                pass
                except Exception:
                    pass

        return key_to_account, email_to_password

    def load_accounts(self) -> List[Tuple[str, str, Optional[str], str]]:
        """
        Loads accounts from bad_file.
        Supports:
          - email:password:apiKey
          - email:password
          - plain apiKey (looks up email & password automatically)
        Returns list of (email, password, api_key, raw_line).
        """
        if not os.path.exists(self.bad_file):
            return []

        key_to_account, email_to_password = self._build_lookup_maps()
        accounts = []
        seen = set()

        with open(self.bad_file, "r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                parts = raw.split(":")

                email = ""
                password = ""
                api_key = None

                if len(parts) >= 3:
                    email = parts[0].strip()
                    if parts[-1].strip().startswith("thk_") or len(parts[-1].strip()) >= 25:
                        api_key = parts[-1].strip()
                        password = ":".join(parts[1:-1]).strip()
                    else:
                        password = parts[1].strip()
                        api_key = parts[2].strip()
                elif len(parts) == 2:
                    email = parts[0].strip()
                    password = parts[1].strip()
                    for k, (em, _) in key_to_account.items():
                        if em.lower() == email.lower():
                            api_key = k
                            break
                elif len(parts) == 1 and (parts[0].startswith("thk_") or len(parts[0]) >= 25):
                    k = parts[0].strip()
                    api_key = k
                    if k in key_to_account:
                        email, password = key_to_account[k]
                    else:
                        continue
                else:
                    continue

                if not email:
                    continue

                if not password and email.lower() in email_to_password:
                    password = email_to_password[email.lower()]

                if not password:
                    password = os.getenv("TOKENHARBOR_PASSWORD", "torabikA1###########")

                if email.lower() not in seen:
                    seen.add(email.lower())
                    accounts.append((email, password, api_key, raw))

        return accounts

    def _remove_from_file(self, filepath: str, email: str, api_key: Optional[str] = None):
        if not os.path.exists(filepath):
            return
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            remaining_lines = []
            em_lower = email.lower().strip()
            key_str = (api_key or "").strip()
            for l in lines:
                raw = l.strip()
                if not raw or raw.startswith("#"):
                    remaining_lines.append(l)
                    continue
                parts = raw.split(":")
                if parts and parts[0].strip().lower() == em_lower:
                    continue
                if key_str and (key_str in raw or raw == key_str):
                    continue
                remaining_lines.append(l)
            with open(filepath, "w", encoding="utf-8") as f:
                f.writelines(remaining_lines)
        except Exception:
            pass

    async def mark_success(self, email: str, password: str, api_key: str):
        async with self.lock:
            # 1. Append to good_file if not already present
            good_line = f"{email}:{password}:{api_key}\n"
            existing_good = set()
            if os.path.exists(self.good_file):
                with open(self.good_file, "r", encoding="utf-8") as f:
                    for l in f:
                        parts = l.strip().split(":")
                        if parts:
                            existing_good.add(parts[0].lower().strip())
            if email.lower() not in existing_good:
                with open(self.good_file, "a", encoding="utf-8") as f:
                    f.write(good_line)

            # 2. Append to good_key_file if not already present
            existing_keys = set()
            if os.path.exists(self.good_key_file):
                with open(self.good_key_file, "r", encoding="utf-8") as f:
                    for l in f:
                        k = l.strip()
                        if k:
                            existing_keys.add(k)
            if api_key and api_key not in existing_keys:
                with open(self.good_key_file, "a", encoding="utf-8") as f:
                    f.write(f"{api_key}\n")

            # 3. Clean up from bad and need-verif files
            cleanup_files = {
                self.bad_file,
                "apikey-need-verif-tokenharbor.txt",
                "akun-need-verif-tokenharbor.txt",
                "akun-bad-tokenharbor.txt",
            }
            for target_path in cleanup_files:
                if target_path:
                    self._remove_from_file(target_path, email, api_key)

async def run_single_reenable_account(
    email: str,
    password: str,
    api_key: Optional[str],
    proxy: Optional[Proxy],
    reenable_store: ReenableStore,
    store: JsonlStore,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
    gsuite_accounts: Optional[Dict[str, Account]] = None,
    temp_mail: Optional[TempMailClient] = None,
    reverify_mode: bool = False,
) -> Tuple[bool, Optional[str]]:
    # Step 1: Pre-check via API if api_key already present (instant, no browser needed)
    if api_key:
        is_valid, status, msg = verify_tokenharbor_key_api(api_key, timeout_sec=6.0)
        if is_valid:
            logger.info(f"API key untuk {email} SUDAH VALID / AKTIF di TokenHarbor (HTTP 200)! Tidak perlu browser.")
            await reenable_store.mark_success(email, password, api_key)
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "reenabled": True})
            return True, api_key
        else:
            logger.info(f"Pre-check API key {email} -> HTTP {status} ({msg}). Melanjutkan proses browser...")

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
            timeout_ms = 90000 if proxy else 45000
            page.set_default_timeout(timeout_ms)
            page.set_default_navigation_timeout(timeout_ms)
            await setup_turnstile_interceptor(page)

            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            gsuite_acc = gsuite_accounts.get(email.lower()) if gsuite_accounts else None
            is_google = (
                gsuite_acc is not None
                or any(email.lower().endswith(dom) for dom in ["@rurasa.my.id", "@gmail.com", "@googlemail.com"])
            )

            # ── 1. Login flow ──────────────────────────────────────────────
            if is_google:
                logger.info(f"navigating to {DEFAULT_LOGIN_URL} for Google OAuth login ({email})...")
                await page.goto(DEFAULT_LOGIN_URL, wait_until="domcontentloaded", timeout=timeout_ms)
                await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))
                await recover_if_something_snapped(page, target_url=DEFAULT_LOGIN_URL, logger=logger)
                await dismiss_cookie_banner(page, logger=logger)

                if not is_dashboard_url(page.url):
                    if proxy and await is_turnstile_detected(page, logger=logger):
                        logger.warn(f"Cloudflare Turnstile terdeteksi di landing page dengan proxy {proxy.server}! Langsung ganti proxy...")
                        raise TurnstileDetectedException(f"Turnstile detected on landing via proxy {proxy.server}")

                    google_btn = await page.wait_for_selector(
                        'button:has-text("Continue with Google"), button[aria-label="Continue with Google"]',
                        timeout=30000 if proxy else 20000,
                    )
                    if not google_btn:
                        raise RuntimeError("Button 'Continue with Google' tidak ditemukan di halaman login")

                    logger.info("clicking 'Continue with Google'...")
                    try:
                        await google_btn.click(no_wait_after=True, timeout=15000)
                    except Exception:
                        await page.evaluate("""() => {
                            const btn = document.querySelector('button[aria-label="Continue with Google"]') ||
                                        Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Continue with Google'));
                            if (btn) btn.click();
                        }""")
                    await human_delay(1500, 2500)

                    if proxy:
                        for _ in range(8):
                            if "accounts.google.com" in page.url or is_dashboard_url(page.url) or is_onboarding_url(page.url):
                                break
                            if await is_turnstile_detected(page, logger=logger):
                                logger.warn(f"Turnstile terdeteksi saat SSO Google dengan proxy {proxy.server}! Langsung ganti proxy...")
                                raise TurnstileDetectedException(f"Turnstile detected before Google OAuth via proxy {proxy.server}")
                            await asyncio.sleep(0.5)
                    else:
                        await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                    recovery_email = gsuite_acc.recovery_email if gsuite_acc else None
                    post_auth_page = await perform_google_oauth(
                        page=page,
                        email=email,
                        password=password,
                        recovery_email=recovery_email,
                        timeout_sec=120 if proxy else 75,
                        logger=logger,
                    )
                    page = post_auth_page
                    await human_delay(2000, 3500)

                    if proxy:
                        for _ in range(8):
                            if is_dashboard_url(page.url) or is_onboarding_url(page.url):
                                break
                            if await is_turnstile_detected(page, logger=logger):
                                logger.warn(f"Turnstile terdeteksi di callback dengan proxy {proxy.server}! Langsung ganti proxy...")
                                raise TurnstileDetectedException(f"Turnstile detected on callback via proxy {proxy.server}")
                            await asyncio.sleep(0.5)
                    else:
                        await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

                    await handle_finish_and_start_chatting(page, logger)

            else:
                logger.info(f"navigating to {DEFAULT_LOGIN_URL} for credentials form login ({email})...")
                await page.goto(DEFAULT_LOGIN_URL, wait_until="domcontentloaded", timeout=timeout_ms)
                await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))
                await recover_if_something_snapped(page, target_url=DEFAULT_LOGIN_URL, logger=logger)
                await dismiss_cookie_banner(page, logger=logger)

                if not is_dashboard_url(page.url):
                    login_tab = await page.query_selector('button[data-analytics="login-tab-signin"], button:has-text("Sign in")')
                    if login_tab:
                        try:
                            await login_tab.click()
                            await human_delay(300, 600)
                        except Exception:
                            pass

                    # Input email
                    email_input = await page.wait_for_selector('input[name="email"], input[type="email"]', timeout=25000)
                    if not email_input:
                        raise RuntimeError("Field email tidak ditemukan di halaman login")
                    await email_input.fill("")
                    await human_type(page, 'input[name="email"], input[type="email"]', email, min_delay_ms=int(45 * delay_mult), max_delay_ms=int(110 * delay_mult))
                    await human_delay(400, 800)

                    # Input password
                    pwd_input = await page.wait_for_selector('input[name="password"], input[type="password"]', timeout=15000)
                    if not pwd_input:
                        raise RuntimeError("Field password tidak ditemukan di halaman login")
                    await pwd_input.fill("")
                    await human_type(page, 'input[name="password"], input[type="password"]', password, min_delay_ms=int(50 * delay_mult), max_delay_ms=int(115 * delay_mult))
                    await human_delay(600, 1200)

                    if proxy and await is_turnstile_detected(page, logger=logger):
                        logger.warn(f"Turnstile terdeteksi di login form dengan proxy {proxy.server}! Langsung ganti proxy...")
                        raise TurnstileDetectedException(f"Turnstile detected on login form via proxy {proxy.server}")
                    else:
                        await resolve_turnstile_if_present(page, timeout_sec=10, logger=logger)

                    # Tombol Sign in
                    signin_btn = await page.wait_for_selector(
                        'button[type="submit"][data-analytics="login-signin"], button[data-analytics="login-signin"], button[type="submit"]:has-text("Sign in")',
                        timeout=15000,
                    )
                    if not signin_btn:
                        raise RuntimeError("Tombol submit Sign in tidak ditemukan")

                    logger.info("clicking 'Sign in' button...")
                    try:
                        await signin_btn.click(timeout=10000)
                    except Exception:
                        await signin_btn.click(force=True, timeout=5000)

                    # Tunggu redirect ke /dashboard
                    logger.info("waiting for navigation to /dashboard...")
                    redirected = False
                    for _ in range(25):
                        if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                            redirected = True
                            break
                        if is_onboarding_url(page.url) or await page.query_selector('button:has-text("Finish and start chatting")'):
                            if await handle_finish_and_start_chatting(page, logger):
                                if is_dashboard_url(page.url) and not is_onboarding_url(page.url):
                                    redirected = True
                                    break
                        err = await page.evaluate("""() => {
                            const el = document.querySelector('[role="alert"], .alert-danger, .text-danger, .text-red-500, .text-rose-500');
                            return el ? el.textContent : null;
                        }""")
                        if err and any(w in err.lower() for w in ["invalid", "incorrect", "not found", "banned", "disabled"]):
                            raise RuntimeError(f"Login ditolak oleh TokenHarbor: {err.strip()}")
                        await asyncio.sleep(1)

                    if not redirected and not is_dashboard_url(page.url):
                        logger.info("attempting manual navigation to /dashboard...")
                        await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=timeout_ms)
                        await human_delay(1500, 2500)
                        if is_onboarding_url(page.url) or await page.query_selector('button:has-text("Finish and start chatting")'):
                            await handle_finish_and_start_chatting(page, logger)

            # ── 2. Tangani dashboard, modal free models, dan verifikasi email ─
            logger.info("waiting for dashboard content to finish loading...")
            try:
                await page.wait_for_selector("text=LOADING", state="hidden", timeout=15000)
            except Exception:
                pass
            await human_delay(1500, 2500)

            logger.info("checking Enable free models consent modal on dashboard...")
            await recover_if_something_snapped(page, target_url=DASHBOARD_URL, logger=logger)
            await ensure_free_models_enabled(page, logger=logger, timeout_sec=8)
            await dismiss_cookie_banner(page, logger=logger)

            # Cek status perlunya verifikasi email
            needs_verif = await page.evaluate("""() => {
                const text = document.body.innerText || '';
                return text.includes("Verify your email") ||
                       text.includes("Send verification email") ||
                       text.includes("confirmation link") ||
                       text.includes("resend email");
            }""")

            if needs_verif or reverify_mode:
                logger.info(f"Proses verifikasi email untuk {email}...")
                verify_clicked = False
                for _ in range(5):
                    try:
                        await handle_enable_free_models_modal(page, logger=logger, timeout_sec=1)
                        await dismiss_cookie_banner(page)

                        verify_btn = await page.query_selector(
                            'button.btn-float-primary:has-text("Verify email"), button:has-text("Verify email"), button:has-text("Send verification email"), button:has-text("Resend email")'
                        )
                        if verify_btn and await verify_btn.is_enabled():
                            btn_txt = (await verify_btn.text_content() or "").strip()
                            if "email sent" not in btn_txt.lower():
                                logger.info(f"clicking '{btn_txt}' button to dispatch verification email...")
                                try:
                                    await verify_btn.click(timeout=3000)
                                except Exception:
                                    await verify_btn.click(force=True, timeout=2000)
                                verify_clicked = True
                                await human_delay(2000, 3500)
                                break
                            else:
                                logger.info("Tombol verifikasi email sudah dalam status 'Email sent'.")
                                verify_clicked = True
                                break
                    except Exception:
                        pass
                    await asyncio.sleep(1)

                await human_delay(2000, 3500)

                v_url = None
                if is_google:
                    v_url = await retrieve_verification_link_from_gmail(context, email, logger, timeout_sec=90 if proxy else 60)
                elif temp_mail:
                    v_url = await temp_mail.wait_for_verification_link(
                        address=email,
                        timeout_sec=120,
                        interval_sec=2.5,
                        filter_sender="tokenharbor",
                        link_pattern=VERIFY_LINK_RE,
                        target_domain="tokenharbor.ai",
                        logger=logger,
                    )

                if v_url:
                    logger.info(f"navigating to verification URL: {v_url}...")
                    await page.goto(v_url, wait_until="domcontentloaded", timeout=timeout_ms)
                    await human_delay(2500, 4000)
                    await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)
                    try:
                        confirm_btn = await page.query_selector('button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Go to dashboard")')
                        if confirm_btn:
                            await confirm_btn.click()
                            await human_delay(1500, 2500)
                    except Exception:
                        pass
                    await page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=timeout_ms)
                    await human_delay(1500, 2500)
                else:
                    logger.warn("Verification URL tidak dapat diambil dari inbox/gmail.")

            # ── 3. Post-check & pembuatan API key jika perlu ───────────────
            active_key = api_key
            is_valid = False
            if active_key:
                is_valid, status, msg = verify_tokenharbor_key_api(active_key, timeout_sec=8.0)
                if is_valid:
                    logger.info(f"API key ({active_key[:12]}...) BERHASIL TERVERIFIKASI & AKTIF! Live API HTTP 200 OK.")

            if not is_valid:
                logger.info("API key belum aktif atau belum ada, membuat/mengambil API key baru di dashboard...")
                try:
                    new_key = await create_and_extract_api_key(page, email, screenshot_dir, logger)
                    if new_key:
                        is_valid, status, msg = verify_tokenharbor_key_api(new_key, timeout_sec=8.0)
                        if is_valid:
                            logger.info(f"API key baru ({new_key[:12]}...) BERHASIL DIBUAT & DIAKTIFKAN! Live API HTTP 200 OK.")
                            active_key = new_key
                        else:
                            logger.warn(f"API key baru dibuat tapi status live API masih HTTP {status} ({msg})")
                            active_key = new_key
                except Exception as e:
                    logger.warn(f"Gagal membuat API key baru: {e}")

            if is_valid and active_key:
                await reenable_store.mark_success(email, password, active_key)
                store.upsert({"email": email, "status": FlowState.DONE, "apiKey": active_key, "reenabled": True})
                return True, active_key
            else:
                raise RuntimeError(f"Gagal memverifikasi/mengaktifkan akun {email} (API check HTTP {status}: {msg})")

    except GooglePhoneVerificationException as e:
        logger.error(f"Akun {email} terkena verifikasi nomor HP Google saat re-enable/re-verify: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e), "reenable_attempt": True})
        raise
    except TurnstileDetectedException as e:
        logger.warn(f"Cloudflare Turnstile terdeteksi saat re-enable/re-verify akun {email}: {e}")
        raise
    except Exception as e:
        logger.error(f"failed re-enabling/re-verifying for {email}: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e), "reenable_attempt": True})
        return False, None

def get_all_tokenharbor_result_files() -> List[str]:
    """
    Returns all candidate TokenHarbor result file paths, checked across CWD and repo root.
    """
    candidates = [
        "akun-result-tokenharbor.txt",
        "vps/akun-result-tokenharbor.txt",
        "akun-good-tokenharbor.txt",
        "vps/akun-good-tokenharbor.txt",
        "gsuite-api-key.txt",
        "tokenharbor-dataset/akun-result-tokenharbor.txt",
        "../akun-result-tokenharbor.txt",
        "../../akun-result-tokenharbor.txt",
        "../vps/akun-result-tokenharbor.txt",
        "../../vps/akun-result-tokenharbor.txt",
    ]
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for rf in [
        "akun-result-tokenharbor.txt",
        "vps/akun-result-tokenharbor.txt",
        "akun-good-tokenharbor.txt",
        "vps/akun-good-tokenharbor.txt",
        "gsuite-api-key.txt",
    ]:
        candidates.append(os.path.join(repo_root, rf))

    existing: List[str] = []
    seen = set()
    for p in candidates:
        abs_p = os.path.abspath(p)
        if abs_p not in seen and os.path.exists(abs_p):
            seen.add(abs_p)
            existing.append(abs_p)
    return existing

def get_all_tokenharbor_failed_files() -> List[str]:
    candidates = [
        "akun-failed-tokenharbor.txt",
        "vps/akun-failed-tokenharbor.txt",
        "../akun-failed-tokenharbor.txt",
        "../../akun-failed-tokenharbor.txt",
    ]
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for ff in ["akun-failed-tokenharbor.txt", "vps/akun-failed-tokenharbor.txt"]:
        candidates.append(os.path.join(repo_root, ff))

    existing: List[str] = []
    seen = set()
    for p in candidates:
        abs_p = os.path.abspath(p)
        if abs_p not in seen and os.path.exists(abs_p):
            seen.add(abs_p)
            existing.append(abs_p)
    return existing

def get_all_tokenharbor_state_files(current_state_file: str = "") -> List[str]:
    candidates = [
        "state.jsonl",
        "state-tokenharbor.jsonl",
        "vps/state.jsonl",
        "../state.jsonl",
        "../../state.jsonl",
    ]
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for sf in ["state.jsonl", "state-tokenharbor.jsonl", "vps/state.jsonl"]:
        candidates.append(os.path.join(repo_root, sf))

    existing: List[str] = []
    seen = set()
    curr_abs = os.path.abspath(current_state_file) if current_state_file else ""
    for p in candidates:
        abs_p = os.path.abspath(p)
        if abs_p not in seen and os.path.exists(abs_p) and abs_p != curr_abs:
            seen.add(abs_p)
            existing.append(abs_p)
    return existing

def get_completed_emails(store: JsonlStore, results: ResultWriter, current_state_file: str, require_api_key: bool = False) -> Set[str]:
    """
    Returns the unified set of all email addresses that have successfully completed TokenHarbor registration
    and obtained an API key, checked across all sources:
    1. akun-result-tokenharbor.txt (and any result files configured on results)
    2. Primary JsonlStore (status == FlowState.DONE)
    3. Fallback state files (state.jsonl, state-tokenharbor.jsonl, vps/state.jsonl)
    4. All candidate TokenHarbor result files across repo (vps, good, gsuite-api-key, etc.)
    If require_api_key is True, only accounts that actually have a thk_ API key are returned.
    """
    completed: Set[str] = set()
    completed.update(results.get_successful_emails(require_api_key=require_api_key))
    completed.update(store.get_all_done_emails(require_api_key=require_api_key))

    res_files = get_all_tokenharbor_result_files()
    if res_files:
        completed.update(read_emails_from_result_file(res_files, require_api_key=require_api_key))

    for sf in get_all_tokenharbor_state_files(current_state_file):
        try:
            alt = JsonlStore(sf)
            completed.update(alt.get_all_done_emails(require_api_key=require_api_key))
        except Exception:
            pass

    return {e.strip().lower() for e in completed if e and "@" in e}

def get_failed_emails(store: JsonlStore, results: ResultWriter, current_state_file: str) -> Set[str]:
    failed: Set[str] = set()
    failed.update(results.get_failed_emails())
    failed.update(store.get_all_failed_emails())

    fail_files = get_all_tokenharbor_failed_files()
    if fail_files:
        failed.update(read_emails_from_result_file(fail_files))

    for sf in get_all_tokenharbor_state_files(current_state_file):
        try:
            alt = JsonlStore(sf)
            failed.update(alt.get_all_failed_emails())
        except Exception:
            pass

    return {e.strip().lower() for e in failed if e and "@" in e}

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
    parser.add_argument("--proxy-timeout", type=float, default=float(os.getenv("PROXY_PRECHECK_TIMEOUT", "6.0")), help="Timeout in seconds for proxy TokenHarbor HTTP 200 pre-check (default: 6.0s)")
    parser.add_argument("--skip-proxy-precheck", action="store_true", default=os.getenv("SKIP_PROXY_PRECHECK", "0") in ("1", "true", "yes"), help="Skip proxy pre-check before browser launch")
    parser.add_argument("--re-enable-free", action="store_true", help="Re-enable free models for accounts in akun-bad-tokenharbor.txt")
    parser.add_argument("--reverify-email", action="store_true", help="Re-verify email for accounts/keys in apikey-need-verif-tokenharbor.txt")
    parser.add_argument(
        "--gsuite-mode",
        choices=["create_new_key", "skip_existing", "fetch_existing"],
        default=os.getenv("TOKENHARBOR_GSUITE_MODE", "create_new_key"),
        help="GSuite registration mode: create_new_key, skip_existing, or fetch_existing (fetch/create API keys for ALREADY_REGISTERED accounts)",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Alias for --gsuite-mode skip_existing",
    )
    parser.add_argument(
        "--fetch-existing",
        "--fetch-keys",
        dest="fetch_existing",
        action="store_true",
        help="Alias for --gsuite-mode fetch_existing (fetch/create API keys for accounts marked ALREADY_REGISTERED)",
    )
    args = parser.parse_args()

    if args.skip_existing:
        args.gsuite_mode = "skip_existing"
    elif args.fetch_existing:
        args.gsuite_mode = "fetch_existing"

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

    repo_root = REPO_ROOT
    res_path = os.path.join(repo_root, "akun-result-tokenharbor.txt")
    account_result_file = res_path if os.path.exists(res_path) else "akun-result-tokenharbor.txt"
    fail_path = os.path.join(repo_root, "akun-failed-tokenharbor.txt")
    account_failed_file = fail_path if os.path.exists(fail_path) else "akun-failed-tokenharbor.txt"

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file=account_result_file,
        account_failed_file=account_failed_file,
        fallback_result_files=get_all_tokenharbor_result_files(),
        fallback_failed_files=get_all_tokenharbor_failed_files(),
    )

    logger = create_logger()
    logger.info(f"TokenHarbor Camoufox runner started (auth={args.auth}, pace={args.pace}, workers={args.workers}). Proxies loaded: {len(proxies)} (proxy_mode={'no-proxy' if args.no_proxy or not proxies else 'active'})")

    # ── RE-ENABLE / RE-VERIFY FLOW ──────────────────────────────────────────
    if args.re_enable_free or args.reverify_email:
        is_reverify = args.reverify_email
        mode_label = "Re-verifikasi Email" if is_reverify else "Re-enable Free Models"

        if args.accounts_file:
            bad_file = args.accounts_file
        elif is_reverify:
            if os.path.exists("apikey-need-verif-tokenharbor.txt"):
                bad_file = "apikey-need-verif-tokenharbor.txt"
            elif os.path.exists("akun-need-verif-tokenharbor.txt"):
                bad_file = "akun-need-verif-tokenharbor.txt"
            else:
                bad_file = "apikey-need-verif-tokenharbor.txt"
        else:
            bad_file = "akun-bad-tokenharbor.txt"

        if not os.path.exists(bad_file):
            logger.error(f"File {bad_file} tidak ditemukan. Tidak ada akun untuk di-{mode_label.lower()}!")
            return

        reenable_store = ReenableStore(
            bad_file=bad_file,
            good_file="akun-good-tokenharbor.txt",
            good_key_file="apikey-good-tokenharbor.txt",
        )
        todo_accounts = reenable_store.load_accounts()
        if not todo_accounts:
            logger.info(f"Tidak ada akun tersisa di {bad_file}. Semua akun sudah berhasil atau file kosong!")
            return

        target_count = min(args.limit, len(todo_accounts)) if args.limit > 0 else len(todo_accounts)
        worker_count = max(1, min(args.workers, target_count))
        logger.info(
            f"TokenHarbor {mode_label} started: {len(todo_accounts)} akun di {bad_file}, "
            f"target: {target_count}, workers: {worker_count}, proxy: {'direct' if args.no_proxy or not proxies else len(proxies)}"
        )

        if args.dry_run:
            logger.info(f"dry-run: Akun yang akan diproses: {[a[0] for a in todo_accounts[:target_count]]}")
            return

        gsuite_accounts: Dict[str, Account] = {}
        for gpath in ["tokenharbor-dataset/gsuite.txt", "gsuite.txt"]:
            if os.path.exists(gpath):
                try:
                    for a in load_accounts(gpath):
                        gsuite_accounts[a.email.lower()] = a
                except Exception:
                    pass

        temp_mail = TempMailClient(default_domain=args.domain)
        account_queue = deque(todo_accounts[:target_count])
        processed = 0
        success_count = 0
        lock = asyncio.Lock()

        async def reenable_worker(worker_id: int):
            nonlocal processed, success_count
            while True:
                item = None
                proxy = None
                async with lock:
                    if success_count >= target_count or not account_queue:
                        break
                    item = account_queue.popleft()
                    processed += 1

                email, password, api_key, raw_line = item
                acc_logger = create_logger(f"w{worker_id}:{email}")

                if not args.no_proxy and proxies:
                    proxy = await proxy_pool.get_next_live_proxy(
                        target_url=DEFAULT_LOGIN_URL,
                        timeout_sec=args.proxy_timeout,
                        logger=logger,
                        enable_precheck=(not args.skip_proxy_precheck),
                    )
                    if proxy is None:
                        logger.warn(f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted.")
                        break

                turnstile_detected = False
                phone_verification_detected = False
                try:
                    ok, active_key = await run_single_reenable_account(
                        email=email,
                        password=password,
                        api_key=api_key,
                        proxy=proxy,
                        reenable_store=reenable_store,
                        store=store,
                        headed=args.headed,
                        screenshot_dir=args.screenshot_dir,
                        logger=acc_logger,
                        pace=args.pace,
                        gsuite_accounts=gsuite_accounts,
                        temp_mail=temp_mail,
                        reverify_mode=is_reverify,
                    )
                except GooglePhoneVerificationException as pe:
                    ok = False
                    active_key = None
                    phone_verification_detected = True
                    acc_logger.error(f"Akun {email} terkena verifikasi nomor HP Google: {pe}. Melewati akun tanpa retry!")
                except TurnstileDetectedException as te:
                    ok = False
                    active_key = None
                    turnstile_detected = True
                    acc_logger.warn(f"Cloudflare Turnstile terdeteksi saat {mode_label} dengan proxy: {te}")

                async with lock:
                    if proxy_pool and proxy:
                        if ok:
                            proxy_pool.mark_result(proxy, success=True)
                        elif phone_verification_detected:
                            logger.info(f"Worker #{worker_id}: Proxy {proxy.server} tidak diblacklist (kegagalan akun butuh verif HP).")
                        else:
                            proxy_pool.mark_result(proxy, success=False)
                            if turnstile_detected:
                                logger.warn(f"Worker #{worker_id}: Proxy {proxy.server} terblokir Turnstile! Dibuang dari pool dan di-blacklist.")

                    if ok:
                        success_count += 1
                        logger.info(f"Progress {mode_label}: {success_count}/{target_count} akun sukses ({processed}/{target_count} diproses)")
                    elif phone_verification_detected:
                        logger.warn(f"Worker #{worker_id}: Akun {email} membutuhkan verifikasi nomor telepon Google. Dilewati secara permanen.")
                    elif turnstile_detected:
                        logger.info(f"Worker #{worker_id}: Turnstile pada proxy untuk {email}. Menunda akun ke akhir antrean...")
                        account_queue.append(item)

                if success_count < target_count and account_queue:
                    if ok and args.delay > 0:
                        logger.info(f"Worker #{worker_id} waiting {args.delay}s before next account...")
                        await asyncio.sleep(args.delay)
                    elif phone_verification_detected:
                        await asyncio.sleep(1.0)
                    elif turnstile_detected:
                        await asyncio.sleep(0.5)
                    elif not ok:
                        await asyncio.sleep(1.5)

        if worker_count > 1:
            await asyncio.gather(*(reenable_worker(i + 1) for i in range(worker_count)))
        else:
            await reenable_worker(1)

        logger.info(f"TokenHarbor {mode_label} selesai: {success_count}/{target_count} target akun berhasil diproses ({processed} total diproses).")
        return

    # ── GOOGLE OAUTH FLOW ───────────────────────────────────────────────────
    if args.auth == "google":
        is_fetch_existing = (args.gsuite_mode == "fetch_existing")

        if is_fetch_existing:
            # 1. Check all ALREADY_REGISTERED accounts in akun-result-tokenharbor.txt and fallback result files
            raw_reg_accounts = load_already_registered_accounts([results.account_result_file] + results.fallback_result_files)
            existing_reg_map = {a["email"].lower(): a["password"] for a in raw_reg_accounts}

            # 2. Check if accounts_file is provided or discoverable to supply passwords or missing accounts
            accounts_file = args.accounts_file
            if not accounts_file:
                if os.path.exists("tokenharbor-dataset/gsuite.txt"):
                    accounts_file = "tokenharbor-dataset/gsuite.txt"
                elif os.path.exists("gsuite.txt"):
                    accounts_file = "gsuite.txt"

            extra_accounts = load_accounts(accounts_file) if (accounts_file and os.path.exists(accounts_file)) else []
            for ea in extra_accounts:
                if ea.email.lower() in existing_reg_map and not existing_reg_map[ea.email.lower()] and ea.password:
                    existing_reg_map[ea.email.lower()] = ea.password

            # Convert to Account objects
            all_target_accounts: List[Account] = []
            seen_emails = set()
            for item in raw_reg_accounts:
                em = item["email"].strip()
                norm_em = em.lower()
                pwd = existing_reg_map.get(norm_em) or item["password"]
                if norm_em not in seen_emails:
                    seen_emails.add(norm_em)
                    all_target_accounts.append(Account(email=em, password=pwd))

            # Also include any accounts from accounts_file that don't have a valid key in results
            keys_held = get_completed_emails(store, results, args.state_file, require_api_key=True)
            for ea in extra_accounts:
                norm_ea = ea.email.lower().strip()
                if norm_ea not in keys_held and norm_ea not in seen_emails:
                    seen_emails.add(norm_ea)
                    all_target_accounts.append(ea)

            accounts = all_target_accounts
            completed_emails = keys_held
            eligible_accounts = [
                acc for acc in all_target_accounts
                if acc.email.lower() not in completed_emails
                and not store.is_restricted_or_banned(acc.email)
            ]
            logger.info(
                f"Mode Recovery 'fetch_existing' aktif: {len(eligible_accounts)} akun (ALREADY_REGISTERED / belum memiliki key) siap diproses untuk generate API key baru."
            )
        else:
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

            require_key_for_queue = (args.gsuite_mode in ("create_new_key", "fetch_existing"))
            completed_emails = get_completed_emails(store, results, args.state_file, require_api_key=require_key_for_queue)
            failed_emails = get_failed_emails(store, results, args.state_file)

            # Strictly exclude ANY account that has already completed successfully!
            eligible_accounts = [
                acc for acc in accounts
                if acc.email.strip().lower() not in completed_emails
            ]

            if not args.retry_failed:
                eligible_accounts = [
                    acc for acc in eligible_accounts
                    if acc.email.strip().lower() not in failed_emails
                    and not store.is_restricted_or_banned(acc.email)
                ]
            else:
                logger.info("Retry mode active: prioritizing previously failed accounts at the front of the queue.")
                # Even in retry mode, permanently unrecoverable accounts (restricted, banned, phone verification) must NOT be retried
                eligible_accounts = [
                    acc for acc in eligible_accounts
                    if not store.is_restricted_or_banned(acc.email)
                    and acc.email.strip().lower() not in completed_emails
                ]
                def sort_key(acc):
                    return 0 if acc.email.strip().lower() in failed_emails else 1
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

                if account is None:
                    # In-flight workers might re-queue an account
                    await asyncio.sleep(1.0)
                    continue

                norm_email = account.email.strip().lower()

                # Fast pre-check: strictly skip accounts that are already in akun-result-tokenharbor.txt or completed
                if args.gsuite_mode == "skip_existing":
                    if norm_email in completed_emails or norm_email in results.get_successful_emails(require_api_key=False):
                        logger.info(
                            f"⏭️ [SKIP] Akun {account.email} sudah tercatat di akun-result-tokenharbor.txt. "
                            f"Langsung dilewati tanpa mengambil proxy & tanpa membuka browser!"
                        )
                        async with lock:
                            in_flight -= 1
                        continue
                elif args.gsuite_mode in ("create_new_key", "fetch_existing"):
                    if norm_email in completed_emails or norm_email in results.get_successful_emails(require_api_key=True):
                        logger.info(
                            f"⏭️ [SKIP] Akun {account.email} sudah memiliki API key di akun-result-tokenharbor.txt. "
                            f"Langsung dilewati tanpa mengambil proxy & tanpa membuka browser!"
                        )
                        async with lock:
                            in_flight -= 1
                        continue

                if not args.no_proxy and proxies:
                    proxy = await proxy_pool.get_next_live_proxy(
                        target_url=DEFAULT_SIGNUP_URL,
                        timeout_sec=args.proxy_timeout,
                        logger=logger,
                        enable_precheck=(not args.skip_proxy_precheck),
                    )
                    if proxy is None:
                        logger.warn(
                            f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left."
                        )
                        async with lock:
                            account_queue.appendleft(account)
                            in_flight -= 1
                        break
                    proxy_addr = proxy_pool.address_of(proxy)
                    reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                    logger.info(
                        f"Worker #{worker_id} selected verified proxy: {proxy.server} ({proxy_addr}){reuse_tag}. "
                        f"(Fresh remaining: {len(proxy_pool.fresh_proxies)}, Good pool: {len(proxy_pool.good_proxies)})"
                    )
                else:
                    proxy = None

                async with lock:
                    processed += 1

                acc_logger = create_logger(f"w{worker_id}:{account.email}")
                logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")
                will_retry_if_failed = (
                    proxy_pool is not None
                    and proxy_pool.has_proxies
                    and attempts_per_account[account.email] < MAX_PROXY_ATTEMPTS - 1
                )
                turnstile_detected = False
                phone_verification_detected = False
                ok = False
                try:
                    ok = await asyncio.wait_for(
                        run_single_google_account(
                            account=account,
                            proxy=proxy,
                            store=store,
                            results=results,
                            headed=args.headed,
                            screenshot_dir=args.screenshot_dir,
                            logger=acc_logger,
                            pace=args.pace,
                            mark_failed_on_error=(not will_retry_if_failed),
                            gsuite_mode=args.gsuite_mode,
                        ),
                        timeout=240.0,
                    )
                except asyncio.TimeoutError:
                    ok = False
                    acc_logger.error(f"HARD TIMEOUT: Eksekusi akun Google {account.email} melebihi batas 240 detik!")
                    results.mark_failed(account.email, account.password, "HARD_TIMEOUT_240S")
                except GooglePhoneVerificationException as pe:
                    ok = False
                    phone_verification_detected = True
                    acc_logger.error(f"Akun {account.email} terkena verifikasi nomor HP Google: {pe}. Melewati akun tanpa retry!")
                except TurnstileDetectedException as te:
                    ok = False
                    turnstile_detected = True
                    acc_logger.warn(f"Cloudflare Turnstile terdeteksi: {te}")
                except Exception as e:
                    ok = False
                    acc_logger.error(f"Worker #{worker_id} unhandled error on {account.email}: {e}")
                finally:
                    if worker_count == 1:
                        cleanup_leftover_browser_processes()
                        cleanup_temp_profiles()

                async with lock:
                    in_flight -= 1
                    if proxy_pool and proxy:
                        if ok:
                            proxy_pool.mark_result(proxy, success=True)
                            logger.info(f"Worker #{worker_id}: Proxy {proxy.server} verified GOOD! Added to reusable proxy pool.")
                        elif phone_verification_detected:
                            # Masalah bukan pada proxy, jangan blacklist proxy
                            logger.info(f"Worker #{worker_id}: Proxy {proxy.server} tidak diblacklist (kegagalan akun Google butuh verif HP).")
                        else:
                            proxy_pool.mark_result(proxy, success=False)
                            if turnstile_detected:
                                logger.warn(f"Worker #{worker_id}: Proxy {proxy.server} terblokir Turnstile! Dibuang dari pool dan di-blacklist.")
                            else:
                                logger.warn(f"Worker #{worker_id}: Proxy {proxy.server} failed/rejected. Discarded and will not be reused.")

                    if ok:
                        success_count += 1
                        logger.info(f"Progress: {success_count}/{target_count} accounts completed successfully.")
                    elif phone_verification_detected:
                        # Akun meminta verifikasi nomor HP Google:
                        # JANGAN retry, JANGAN append ke account_queue!
                        logger.warn(
                            f"Worker #{worker_id}: Akun {account.email} memerlukan verifikasi nomor telepon Google. "
                            f"Akun dilewati secara permanen dan TIDAK akan dicoba kembali (no retry)."
                        )
                    elif turnstile_detected:
                        # Turnstile captcha detected on proxy:
                        # Jangan kurangi jatah attempt akun, jangan tandai gagal!
                        # Geser akun ke paling belakang antrean agar proses lanjut ke akun lain dulu.
                        logger.info(
                            f"Worker #{worker_id}: Cloudflare Turnstile terdeteksi pada proxy untuk {account.email}. "
                            f"Menunda akun ini ke akhir antrean agar lanjut memproses akun lain terlebih dahulu..."
                        )
                        account_queue.append(account)
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
                    elif phone_verification_detected:
                        logger.info(f"Worker #{worker_id} beralih langsung ke akun berikutnya...")
                        await asyncio.sleep(1.0)
                    elif turnstile_detected:
                        # Rotasi cepat ke akun lain
                        await asyncio.sleep(0.5)
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
                proxy = await proxy_pool.get_next_live_proxy(
                    target_url=DEFAULT_SIGNUP_URL,
                    timeout_sec=args.proxy_timeout,
                    logger=logger,
                    enable_precheck=(not args.skip_proxy_precheck),
                )
                if proxy is None:
                    logger.warn(f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left.")
                    break
                proxy_addr = proxy_pool.address_of(proxy)
                reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                logger.info(f"Worker #{worker_id} selected verified proxy: {proxy.server} ({proxy_addr}){reuse_tag}. (Fresh remaining: {len(proxy_pool.fresh_proxies)}, Good pool: {len(proxy_pool.good_proxies)})")
            else:
                proxy = None

            async with lock:
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
            logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")

            ok = False
            try:
                ok = await asyncio.wait_for(
                    run_single_account(
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
                    ),
                    timeout=240.0,
                )
            except asyncio.TimeoutError:
                acc_logger.error(f"HARD TIMEOUT: Eksekusi akun {email} melebihi batas 240 detik!")
                results.mark_failed(email, password, "HARD_TIMEOUT_240S")
                ok = False
            except Exception as e:
                acc_logger.error(f"Worker #{worker_id} unhandled error on {email}: {e}")
                ok = False
            finally:
                if worker_count == 1:
                    cleanup_leftover_browser_processes()
                    cleanup_temp_profiles()

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
