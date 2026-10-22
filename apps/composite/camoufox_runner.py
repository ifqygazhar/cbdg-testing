#!/usr/bin/env python3
"""
Composite Lucidity Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on Composite Lucidity using TempMail-Pro,
solves Cloudflare Turnstile automatically, generates API keys,
and saves credentials and tokens to akun-result-composite.txt and apikey-composite.txt.
"""

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
import random
import re
import sys
import time
from typing import Optional, List, Dict, Any, Tuple, Union
from urllib.parse import urlparse

import requests
from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

# Ensure parent directory is in sys.path so packages.camoufox_core can be imported
workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if workspace_root not in sys.path:
    sys.path.insert(0, workspace_root)

from packages.camoufox_core import (
    launch_camoufox,
    get_browser_fingerprint_info,
    human_delay,
    human_type,
    setup_process_signals,
    kill_descendant_processes,
    cleanup_leftover_browser_processes,
    cleanup_temp_profiles,
    get_vps_system_status,
    safe_close_browser,
    Account,
    Proxy,
    load_proxies,
    JsonlStore,
    ResultWriter,
    FlowState,
    create_logger,
    Logger,
    TempMailClient,
    resolve_turnstile_if_present,
    dismiss_turnstile_modal,
    setup_turnstile_interceptor,
    inject_turnstile_token,
    read_emails_from_result_file,
    TurnstileFailedException,
    is_turnstile_failed,
)
from packages.camoufox_core.turnstile import find_turnstile_target

API_KEY_RE = re.compile(r"\bcmp-[a-f0-9]{32}\b", re.IGNORECASE)
API_KEY_FALLBACK_RE = re.compile(r"\bcmp-[A-Za-z0-9_\-]{20,}\b", re.IGNORECASE)

DEFAULT_SIGNUP_URL = "https://composite.lucidity.sh/login.html?mode=register"
DEFAULT_DASHBOARD_URL = "https://composite.lucidity.sh/dashboard.html"
DEFAULT_APIKEYS_URL = "https://composite.lucidity.sh/apikeys.html"


def sanitize_username(email: str) -> str:
    local_part = email.split("@")[0] if "@" in email else email
    clean = re.sub(r"[^a-zA-Z0-9_.\-]", "", local_part)
    if len(clean) < 3:
        clean = f"{clean}{random.randint(100, 999)}"
    if len(clean) > 30:
        clean = clean[:30]
    return clean


def extract_proxy_address(proxy_str: str) -> str:
    try:
        u = proxy_str if "://" in proxy_str else f"http://{proxy_str}"
        return urlparse(u).hostname or proxy_str
    except Exception:
        return proxy_str


def check_proxy_single_sync(
    proxy: Proxy,
    target_url: str = "https://composite.lucidity.sh/login.html",
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
    target_url: str = "https://composite.lucidity.sh/login.html",
    timeout_sec: float = 6.0,
) -> List[Tuple[Proxy, bool, Union[int, str], float]]:
    with ThreadPoolExecutor(max_workers=min(len(candidates), 20)) as pool:
        futures = [
            pool.submit(check_proxy_single_sync, p, target_url, timeout_sec)
            for p in candidates
        ]
        return [f.result() for f in futures]


class CompositeProxyPool:
    """Manages fresh and verified proxies with concurrent batch pre-checking."""

    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies: List[Proxy] = list(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: set = set()
        self.reuse_proxy: bool = reuse_proxy
        self._lock = asyncio.Lock()

    def address_of(self, proxy: Proxy) -> str:
        return extract_proxy_address(proxy.server)

    async def get_next_live_proxy(
        self,
        target_url: str = "https://composite.lucidity.sh/login.html",
        timeout_sec: float = 6.0,
        batch_size: int = 15,
        logger: Optional[Logger] = None,
        enable_precheck: bool = True,
    ) -> Optional[Proxy]:
        async with self._lock:
            # 1. Re-use verified good proxy if configured
            if self.reuse_proxy and self.good_proxies:
                chosen = self.good_proxies.pop(0)
                self.good_proxies.append(chosen)
                return chosen

            while True:
                # 2. Check existing verified pool
                if self.good_proxies:
                    chosen = self.good_proxies.pop(0)
                    if self.reuse_proxy:
                        self.good_proxies.append(chosen)
                    return chosen

                # 3. Pull candidates from fresh list
                candidates: List[Proxy] = []
                while self.fresh_proxies and len(candidates) < batch_size:
                    cand = self.fresh_proxies.pop(0)
                    addr = self.address_of(cand)
                    if addr not in self.bad_addresses:
                        candidates.append(cand)

                if not candidates:
                    if self.good_proxies:
                        chosen = self.good_proxies.pop(0)
                        if self.reuse_proxy:
                            self.good_proxies.append(chosen)
                        return chosen
                    return None

                if not enable_precheck:
                    chosen = candidates[0]
                    if len(candidates) > 1:
                        self.fresh_proxies = candidates[1:] + self.fresh_proxies
                    return chosen

                if logger:
                    logger.info(
                        f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against Composite "
                        f"(HTTP 200, timeout={timeout_sec}s)... (Fresh remaining: {len(self.fresh_proxies)}, Good pool: {len(self.good_proxies)})"
                    )

                loop = asyncio.get_running_loop()
                results = await loop.run_in_executor(
                    None,
                    check_proxy_batch_sync,
                    candidates,
                    target_url,
                    timeout_sec,
                )

                good_batch: List[Proxy] = []
                bad_count = 0
                for proxy, ok, status, dt in results:
                    addr = self.address_of(proxy)
                    if ok:
                        good_batch.append(proxy)
                        if logger:
                            logger.info(f"✅ Proxy pre-check PASSED: {proxy.server} ({addr}) -> HTTP 200 in {dt}s")
                    else:
                        self.bad_addresses.add(addr)
                        bad_count += 1

                if bad_count > 0 and logger:
                    logger.info(f"⏭️ Discarded {bad_count} dead/non-200 proxies from batch.")

                if good_batch:
                    chosen = good_batch[0]
                    if len(good_batch) > 1:
                        for p in good_batch[1:]:
                            if p not in self.good_proxies:
                                self.good_proxies.append(p)
                    return chosen

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
            self.fresh_proxies = [p for p in self.fresh_proxies if self.address_of(p) != addr]

    @property
    def has_proxies(self) -> bool:
        return bool(self.fresh_proxies or self.good_proxies)

    @property
    def fresh_count(self) -> int:
        return len(self.fresh_proxies)

    @property
    def good_count(self) -> int:
        return len(self.good_proxies)


async def create_and_extract_api_key(
    page: Page,
    screenshot_dir: str,
    logger: Logger,
    pace: str = "fast",
) -> str:
    """
    Navigates to /apikeys.html, opens modal, creates API key, and extracts cmp- token.
    """
    logger.info("navigating to https://composite.lucidity.sh/apikeys.html")
    await page.goto(DEFAULT_APIKEYS_URL, wait_until="domcontentloaded", timeout=35000)
    await human_delay(1500, 2500, pace=pace)

    # In case of redirect, re-check URL
    if "/login.html" in page.url:
        raise RuntimeError("Redirected to login while trying to access /apikeys.html (Session not established)")

    # Intercept clipboard writeText to reliably capture copied key
    await page.evaluate("""() => {
        window.__copied_key = null;
        if (navigator.clipboard) {
            const origWriteText = navigator.clipboard.writeText;
            navigator.clipboard.writeText = function(text) {
                window.__copied_key = text;
                return origWriteText ? origWriteText.apply(this, arguments) : Promise.resolve();
            };
        }
    }""")

    # Intercept API response from POST /api/keys
    captured_keys: List[str] = []

    async def handle_response(response):
        try:
            if "/api/keys" in response.url and response.request.method == "POST":
                data = await response.json()
                key_val = data.get("key") or data.get("id") or data.get("apiKey") or ""
                if key_val:
                    m = API_KEY_RE.search(key_val) or API_KEY_FALLBACK_RE.search(key_val)
                    if m:
                        captured_keys.append(m.group(0))
        except Exception:
            pass

    page.on("response", handle_response)

    # Locate 'New key' button
    logger.info("locating 'New key' button...")
    new_key_btn = page.locator('button:has-text("New key"), .keys-tabbar button.btn-primary').first
    await new_key_btn.wait_for(state="visible", timeout=15000)
    await human_delay(400, 800, pace=pace)
    await new_key_btn.click()

    # Modal appears: New API key form
    logger.info("waiting for 'New API key' modal form...")
    modal_title = page.locator("#create-key-title, .modal-title:has-text('New API key')").first
    await modal_title.wait_for(state="visible", timeout=10000)

    # Fill key name
    key_input = page.locator("input#key-name-input")
    if await key_input.count() > 0 and await key_input.first.is_visible():
        key_name = f"Key-{random.randint(1000, 9999)}"
        logger.info(f"typing key name: {key_name}")
        await key_input.first.click()
        await page.keyboard.type(key_name, delay=random.randint(20, 50))
        await human_delay(300, 600, pace=pace)

    # Submit key creation
    submit_btn = page.locator('.modal-card button[type="submit"], button:has-text("Create key")').first
    logger.info("submitting key creation form...")
    if await submit_btn.count() > 0:
        await submit_btn.click()
    else:
        await page.keyboard.press("Enter")

    # Wait for key created modal
    logger.info("waiting for 'Key created' popup...")
    key_created_title = page.locator("#new-key-title, .modal-title:has-text('Key created')").first
    await key_created_title.wait_for(state="visible", timeout=15000)

    # Try 1: Read from code.new-key-display
    key_display = page.locator("code.new-key-display").first
    api_key: Optional[str] = None
    if await key_display.count() > 0:
        raw_text = (await key_display.text_content() or "").strip()
        m = API_KEY_RE.search(raw_text) or API_KEY_FALLBACK_RE.search(raw_text)
        if m:
            api_key = m.group(0)
            logger.info(f"Found API key via DOM code element: {api_key[:8]}...")

    # Try 2: Click Copy button and check clipboard hook
    if not api_key:
        copy_btn = page.locator('button:has-text("Copy key"), .modal-card button.btn-primary').first
        if await copy_btn.count() > 0 and await copy_btn.is_visible():
            await copy_btn.click()
            await asyncio.sleep(0.5)
            copied = await page.evaluate("() => window.__copied_key")
            if copied:
                m = API_KEY_RE.search(copied) or API_KEY_FALLBACK_RE.search(copied)
                if m:
                    api_key = m.group(0)
                    logger.info(f"Found API key via clipboard intercept: {api_key[:8]}...")

    # Try 3: Check captured response
    if not api_key and captured_keys:
        api_key = captured_keys[0]
        logger.info(f"Found API key via network response intercept: {api_key[:8]}...")

    # Try 4: Regex over entire page content
    if not api_key:
        page_html = await page.content()
        m = API_KEY_RE.search(page_html) or API_KEY_FALLBACK_RE.search(page_html)
        if m:
            api_key = m.group(0)
            logger.info(f"Found API key via regex in page content: {api_key[:8]}...")

    if not api_key:
        screenshot_path = os.path.join(screenshot_dir, f"apikey-fail-{int(time.time())}.png")
        await page.screenshot(path=screenshot_path)
        raise RuntimeError(f"Failed to extract Composite API key. Screenshot: {screenshot_path}")

    return api_key


async def run_composite_single(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    args: argparse.Namespace,
    temp_mail: TempMailClient,
    logger: Logger,
) -> bool:
    email = account.email
    password = account.password

    store.upsert({
        "email": email,
        "password": password,
        "status": FlowState.PENDING,
        "proxy": proxy.server if proxy else "direct",
        "updatedAt": int(time.time() * 1000),
    })

    screenshot_dir = getattr(args, "screenshot_dir", "screenshots-composite")
    os.makedirs(screenshot_dir, exist_ok=True)

    browser_ctx = await launch_camoufox(
        headless=not args.headed,
        proxy=proxy,
        geoip=True,
    )

    async with browser_ctx as browser:
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()
        page.set_default_timeout(35000)

        fp_info = await get_browser_fingerprint_info(page)
        if fp_info:
            gpu_tag = f" | GPU={fp_info.get('renderer')[:35]}" if fp_info.get('renderer') and fp_info.get('renderer') != 'unknown' else ""
            logger.info(f"🛡️ Camoufox Fingerprint: OS={fp_info.get('platform')} | Screen={fp_info.get('screen')} | Viewport={fp_info.get('viewport')} | Cores={fp_info.get('cores')}{gpu_tag} | UA={fp_info.get('ua')}")

        # Hook window.turnstile.render to capture callbacks
        await setup_turnstile_interceptor(page)

        try:
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            store.upsert({"email": email, "status": FlowState.SIGNUP, "updatedAt": int(time.time() * 1000)})
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded", timeout=40000)
            await human_delay(1500, 2500, pace=args.pace)

            # Check if already logged in
            if "/dashboard.html" in page.url or "/apikeys.html" in page.url:
                logger.info("Already logged in! Proceeding straight to API key creation...")
            else:
                # Ensure Register tab is selected
                username_input = page.locator("#reg-username")
                if await username_input.count() == 0 or not await username_input.first.is_visible():
                    logger.info("Switching to Register tab...")
                    reg_tab = page.locator('button[role="tab"]:has-text("Register"), .tabs button.tab:nth-child(2)').first
                    if await reg_tab.count() > 0:
                        await reg_tab.click()
                        await human_delay(600, 1000, pace=args.pace)

                username = sanitize_username(email)
                logger.info(f"filling registration form: username='{username}', email='{email}'")

                # Type username
                user_loc = page.locator("#reg-username")
                await user_loc.wait_for(state="visible", timeout=20000)
                await user_loc.click()
                await page.keyboard.type(username, delay=random.randint(30, 60))
                await human_delay(200, 400, pace=args.pace)

                # Type email
                email_loc = page.locator("#reg-email")
                await email_loc.click()
                await page.keyboard.type(email, delay=random.randint(25, 50))
                await human_delay(200, 400, pace=args.pace)

                # Type password
                pwd_loc = page.locator("#reg-password")
                await pwd_loc.click()
                await page.keyboard.type(password, delay=random.randint(25, 45))
                await human_delay(200, 400, pace=args.pace)

                # Type confirm password
                confirm_loc = page.locator("#reg-confirm")
                await confirm_loc.click()
                await page.keyboard.type(password, delay=random.randint(25, 45))
                await human_delay(400, 800, pace=args.pace)

                # Solve Cloudflare Turnstile
                logger.info("🛡️ Checking and auto-verifying Cloudflare Turnstile...")
                turnstile_solved = await resolve_turnstile_if_present(page, timeout_sec=30, logger=logger)
                if not turnstile_solved:
                    logger.warn("Turnstile check not definitively solved before submit, attempting click anyway...")

                # Click Create account
                submit_btn = page.locator('form:not([hidden]) button[type="submit"], button[type="submit"]:has-text("Create account")').first
                logger.info("clicking 'Create account' button...")
                await submit_btn.click()

                # Wait for redirect to dashboard/account or error alert
                start_t = time.time()
                navigated = False
                while time.time() - start_t < 25.0:
                    cur_url = page.url
                    if "/dashboard.html" in cur_url or "/apikeys.html" in cur_url or "/account.html" in cur_url:
                        navigated = True
                        break

                    err_alert = page.locator(".alert.alert-error")
                    if await err_alert.count() > 0 and await err_alert.first.is_visible():
                        err_text = (await err_alert.first.text_content() or "").strip()
                        if err_text:
                            raise RuntimeError(f"Registration failed with error alert: {err_text}")

                    await asyncio.sleep(0.5)

                if not navigated and "/login.html" in page.url:
                    err_alert = page.locator(".alert.alert-error")
                    err_text = (await err_alert.first.text_content() or "").strip() if await err_alert.count() > 0 else ""
                    raise RuntimeError(f"Registration timed out without navigating to dashboard. Alert: {err_text}")

            store.upsert({"email": email, "status": FlowState.DASHBOARD, "updatedAt": int(time.time() * 1000)})
            logger.info("Registration successful, now navigating to API keys page...")

            # Create and extract API key
            store.upsert({"email": email, "status": FlowState.API_KEY, "updatedAt": int(time.time() * 1000)})
            api_key = await create_and_extract_api_key(page, screenshot_dir, logger, pace=args.pace)

            # Record final success
            store.upsert({
                "email": email,
                "password": password,
                "status": FlowState.DONE,
                "apiKey": api_key,
                "updatedAt": int(time.time() * 1000),
            })
            results.mark_success(email, password, api_key)

            # Also mirror to composite_dataset/apikey-composite.txt if dataset folder exists
            dataset_dir = os.path.join(workspace_root, "composite_dataset")
            if os.path.exists(dataset_dir):
                dataset_key_file = os.path.join(dataset_dir, "apikey-composite.txt")
                try:
                    with open(dataset_key_file, "a", encoding="utf-8") as f:
                        f.write(f"{api_key}\n")
                except Exception:
                    pass

            logger.info(f"🎉 Successfully created Composite account and extracted API key: {api_key}")
            return True

        except TurnstileFailedException as tfe:
            logger.error(f"❌ Turnstile Verification FAILED for {email} ({proxy.server if proxy else 'direct IP'}). Discarding proxy immediately.")
            store.upsert({
                "email": email,
                "password": password,
                "status": FlowState.FAILED,
                "notes": "TURNSTILE_FAILED_FLAGGED_IP",
                "updatedAt": int(time.time() * 1000),
            })
            results.mark_failed(email, "TURNSTILE_FAILED_FLAGGED_IP")
            raise

        except Exception as e:
            err_msg = str(e)
            logger.error(f"FAILED for {email}: {err_msg}")
            store.upsert({
                "email": email,
                "password": password,
                "status": FlowState.FAILED,
                "notes": err_msg,
                "updatedAt": int(time.time() * 1000),
            })
            results.mark_failed(email, err_msg)
            return False
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


async def main():
    parser = argparse.ArgumentParser(description="Composite Lucidity Camoufox Runner")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed mode")
    parser.add_argument("--delay", type=int, default=2, help="Seconds delay between accounts")
    parser.add_argument("--state-file", default="state-composite.jsonl", help="State file path")
    parser.add_argument("--limit", type=int, default=1, help="Number of accounts to create")
    parser.add_argument("--domain", default="ifqy.net", help="TempMail domain (@ifqy.net, @meongtopup.my.id, etc.)")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default="fast", help="Typing cadence")
    parser.add_argument("--auth", choices=["tempmail"], default="tempmail", help="Authentication method (tempmail only)")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Concurrent worker count")
    parser.add_argument("--no-proxy", action="store_true", help="Disable proxy usage and run direct")
    parser.add_argument("--with-proxy", action="store_true", help="Enable proxy usage")
    parser.add_argument("--proxy-file", default=None, help="Proxy file path (default: proxy-live.txt / proxy.txt)")
    parser.add_argument("--reuse-proxy", action="store_true", help="Allow recycling proxies")
    parser.add_argument("--unique-proxy", action="store_true", help="Require 1 account 1 unique IP")
    parser.add_argument("--password", default="torabikA1###########", help="Default account password")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--retry-failed", action="store_true", help="Retry failed accounts")
    parser.add_argument("--proxy-timeout", type=float, default=6.0, help="Proxy precheck timeout in seconds")
    parser.add_argument("--skip-proxy-precheck", action="store_true", help="Skip pre-checking proxies")
    parser.add_argument("--screenshot-dir", default="screenshots-composite", help="Screenshot output folder")

    args = parser.parse_args()
    setup_process_signals()

    logger = create_logger("composite")

    # Resolve proxies
    args.use_proxy = not args.no_proxy
    proxies: List[Proxy] = []
    if args.use_proxy:
        p_file = args.proxy_file
        if not p_file:
            if os.path.exists("proxy-live.txt"):
                p_file = "proxy-live.txt"
            elif os.path.exists("proxy.txt"):
                p_file = "proxy.txt"

        if p_file and os.path.exists(p_file):
            proxies = load_proxies(p_file)
            logger.info(f"Loaded {len(proxies)} proxies for Composite (reuse={args.reuse_proxy})")
        else:
            logger.warn("No proxy file found, falling back to direct connection.")
            args.use_proxy = False

    proxy_pool = CompositeProxyPool(proxies, reuse_proxy=args.reuse_proxy) if (args.use_proxy and proxies) else None

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=["apikey-composite.txt"],
        account_result_file="akun-result-composite.txt",
        account_failed_file="akun-failed-composite.txt",
    )

    tempmail_domain = args.domain or "ifqy.net"
    if tempmail_domain.startswith("temp."):
        tempmail_domain = tempmail_domain[5:]
    if "://" in tempmail_domain:
        tempmail_domain = tempmail_domain.split("://")[1].split("/")[0]
        if tempmail_domain.startswith("temp."):
            tempmail_domain = tempmail_domain[5:]

    temp_mail_base_url = os.getenv("TEMPMAIL_BASE_URL", "https://temp-postservice.verifwebsitepro.workers.dev")
    temp_mail_api_key = os.getenv("TEMPMAIL_API_KEY", "anjingmemekkontol")
    temp_mail = TempMailClient(base_url=temp_mail_base_url, default_domain=tempmail_domain, api_key=temp_mail_api_key)

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
                    target_url="https://composite.lucidity.sh/login.html",
                    timeout_sec=args.proxy_timeout,
                    logger=logger,
                    enable_precheck=(not args.skip_proxy_precheck),
                )
                if proxy is None:
                    logger.warn(f"Worker #{worker_id}: All proxies have been exhausted or blacklisted. No usable proxies left.")
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

            password = args.password or "torabikA1###########"
            acc_logger = create_logger(f"w{worker_id}:{email}")
            logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")

            ok = False
            try:
                ok = await asyncio.wait_for(
                    run_composite_single(
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
            except TurnstileFailedException:
                ok = False
                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, False)
                    acc_logger.warn(f"🚫 Flagged proxy {proxy.server} permanently discarded from pool due to Turnstile failure.")
                elif not proxy:
                    acc_logger.error(
                        "❌ IP mesin langsung (direct) gagal verifikasi Cloudflare Turnstile ('Verification failed'). "
                        "IP VPS/datacenter umumnya langsung diblokir oleh Cloudflare Turnstile auto-check. "
                        "Harap jalankan dengan proxy (--with-proxy) agar otomatis merotasi ke IP fresh."
                    )
            except Exception as e:
                acc_logger.error(f"Worker #{worker_id} unhandled error: {e}")
                ok = False

            if proxy_pool and proxy and ok:
                proxy_pool.mark_result(proxy, True)
                acc_logger.info(f"Proxy {proxy.server} verified GOOD! Added to reusable proxy pool.")
            elif proxy_pool and proxy and not ok:
                proxy_pool.mark_result(proxy, False)
                acc_logger.warn(f"Proxy {proxy.server} failed/rejected. Discarded.")

            if ok:
                async with lock:
                    success_count += 1
                logger.info(f"Progress: {success_count}/{count} accounts succeeded.")

            if success_count < count and args.delay > 0:
                await asyncio.sleep(args.delay)

    workers = [asyncio.create_task(tempmail_worker(i + 1)) for i in range(worker_count)]
    try:
        await asyncio.gather(*workers)
    finally:
        kill_descendant_processes()
        cleanup_leftover_browser_processes()
        cleanup_temp_profiles()

    logger.info(f"Composite finished. Succeeded: {success_count}/{count} (Total processed attempts: {processed})")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[SIGINT] Interrupted by user. Exiting cleanly.")
        kill_descendant_processes()
        cleanup_leftover_browser_processes()
        cleanup_temp_profiles()
        sys.exit(130)
