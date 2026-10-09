#!/usr/bin/env python3
"""
Webshare Free-Proxy Camoufox Runner (Python + Camoufox / Firefox engine)
Automates Webshare free proxy harvesting (10 proxies per account):
1. Navigates to Webshare register page with direct Google OAuth flow
2. Performs automated Google OAuth with GSuite account
3. Exchanges token, accesses dashboard, and navigates to proxy list
4. Intercepts authorization token and harvests the 10 direct free proxies via Webshare API
5. Appends harvested proxies into proxy.txt and logs results
"""

from __future__ import annotations
import argparse
import asyncio
from collections import deque
import concurrent.futures
import datetime
import html
import json
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Tuple, Union, Dict, Any
from urllib.parse import urlparse, parse_qs, unquote
import requests

# Ensure repo root is on sys.path
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
    FlowState,
    create_logger,
    setup_process_signals,
    kill_descendant_processes,
)
from packages.camoufox_core.turnstile import find_turnstile_target


class TurnstileDetectedException(Exception):
    """Raised when Cloudflare Turnstile captcha is detected when using proxy."""
    pass


async def is_turnstile_detected(page) -> bool:
    """Checks if Cloudflare Turnstile widget or challenge iframe is currently present."""
    try:
        target = await find_turnstile_target(page)
        if target:
            return True
        if await page.locator("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']").count() > 0:
            return True
        content = (await page.content() or "").lower()
        if "cf-turnstile" in content or "turnstile challenge" in content:
            return True
        return False
    except Exception:
        return False


def format_proxy_line(addr: str, port: int, user: str, pwd: str, fmt: str = "url") -> str:
    if fmt == "webshare":
        return f"{addr}:{port}:{user}:{pwd}"
    cred = f"{user}:{pwd}@" if user else ""
    return f"http://{cred}{addr}:{port}"


class WebshareResultWriter:
    def __init__(self, success_file: str, failed_file: str, proxy_file: str, proxy_format: str = "url"):
        self.success_file = success_file
        self.failed_file = failed_file
        self.proxy_file = proxy_file
        self.proxy_format = proxy_format
        for f in [success_file, failed_file, proxy_file]:
            dirname = os.path.dirname(os.path.abspath(f))
            if dirname:
                os.makedirs(dirname, exist_ok=True)

    def get_successful_emails(self) -> Set[str]:
        emails: Set[str] = set()
        if not os.path.exists(self.success_file):
            return emails
        with open(self.success_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("|")
                if parts and "@" in parts[0]:
                    emails.add(parts[0].strip().lower())
        return emails

    def get_failed_emails(self) -> Set[str]:
        emails: Set[str] = set()
        if not os.path.exists(self.failed_file):
            return emails
        with open(self.failed_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("|")
                if parts and "@" in parts[0]:
                    emails.add(parts[0].strip().lower())
        return emails

    def existing_proxy_lines(self) -> Set[str]:
        lines: Set[str] = set()
        if not os.path.exists(self.proxy_file):
            return lines
        with open(self.proxy_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    lines.add(line)
        return lines

    def mark_success(self, email: str, proxies: List[Dict[str, Any]]) -> int:
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        existing = self.existing_proxy_lines()
        written = 0
        new_lines = []
        for p in proxies:
            line = format_proxy_line(
                addr=p.get("address") or p.get("proxy_address") or "",
                port=int(p.get("port") or 0),
                user=p.get("username") or "",
                pwd=p.get("password") or "",
                fmt=self.proxy_format,
            )
            if line and line not in existing:
                existing.add(line)
                new_lines.append(line)
                written += 1

        if new_lines:
            with open(self.proxy_file, "a", encoding="utf-8") as f:
                for nl in new_lines:
                    f.write(f"{nl}\n")

        with open(self.success_file, "a", encoding="utf-8") as f:
            f.write(f"{email}|{ts}|{len(proxies)} proxies ({written} new)\n")
        return written

    def mark_failed(self, email: str, error: str):
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        sanitized_err = re.sub(r"[\r\n|]+", " ", str(error)).strip()
        with open(self.failed_file, "a", encoding="utf-8") as f:
            f.write(f"{email}|{ts}|{sanitized_err}\n")


class ProxyPool:
    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.proxies = deque(proxies)
        self.reuse_proxy = reuse_proxy
        self.bad_servers: Set[str] = set()

    def get_next_proxy(self) -> Optional[Proxy]:
        if not self.proxies:
            return None
        attempts = len(self.proxies)
        for _ in range(attempts):
            p = self.proxies.popleft()
            if self.reuse_proxy:
                self.proxies.append(p)
            if p.server not in self.bad_servers:
                return p
        return None

    def mark_result(self, proxy: Optional[Proxy], success: bool):
        if not proxy:
            return
        if not success:
            self.bad_servers.add(proxy.server)


SIGNUP_URL = "https://dashboard.webshare.io/register/?start_google_login_flow="
DASHBOARD_URL_RE = re.compile(r"dashboard\.webshare\.io/(dashboard|\d+/)", re.I)
AUTH_EXCHANGE_RE = re.compile(r"dashboard\.webshare\.io/auth/google", re.I)
PLAN_ID_RE = re.compile(r"/(\d{3,})/proxy/list", re.I)
PROXY_LIST_API_URL = "https://proxy.webshare.io/api/v2/proxy/list/"


async def run_single_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: WebshareResultWriter,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
    proxy_format: str = "url",
    dashboard_timeout_sec: int = 90,
    proxy_list_timeout_sec: int = 60,
) -> bool:
    email = account.email
    logger.info(f"starting Webshare signup for {email} (proxy={proxy.server if proxy else 'direct'})")
    store.upsert({"email": email, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    delay_mult = 1.4 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            page = await browser.new_page(ignore_https_errors=True)
            timeout_ms = 45000 if not proxy else 75000
            page.set_default_timeout(timeout_ms)
            page.set_default_navigation_timeout(timeout_ms)

            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # Intercept API calls to capture Authorization token
            auth_token: Optional[str] = None
            intercepted_proxies: List[Dict[str, Any]] = []

            async def on_request(req):
                nonlocal auth_token
                url = req.url
                if "proxy.webshare.io/api/" in url:
                    auth = req.headers.get("authorization")
                    if auth and "token" in auth.lower() and not auth_token:
                        auth_token = auth
                        logger.info("Captured Webshare Authorization token from API traffic!")

            async def on_response(res):
                nonlocal auth_token
                url = res.url
                if "proxy.webshare.io/api/" in url:
                    req_auth = res.request.headers.get("authorization")
                    if req_auth and "token" in req_auth.lower() and not auth_token:
                        auth_token = req_auth
                    if "proxy/list" in url:
                        try:
                            body = await res.json()
                            results_list = body.get("results") or []
                            for row in results_list:
                                if row.get("proxy_address") and row.get("port"):
                                    intercepted_proxies.append(row)
                        except Exception:
                            pass

            page.on("request", on_request)
            page.on("response", on_response)

            # ── 1. Navigate to Webshare Register with Google Login flow ─────
            logger.info(f"navigating to {SIGNUP_URL}...")
            await page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=timeout_ms)
            await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))

            # Check if auto redirect to Google triggered
            on_google = False
            for _ in range(15):
                if "accounts.google.com" in page.url:
                    on_google = True
                    break
                await asyncio.sleep(0.5)

            if not on_google:
                logger.info("auto redirect to google did not fire, clicking 'Sign up with Google' button...")
                google_btn = await page.query_selector('button[data-testid="google-button"], button:has-text("Google")')
                if google_btn:
                    try:
                        await google_btn.click(timeout=5000)
                    except Exception:
                        await google_btn.click(force=True, timeout=3000)
                    await human_delay(1500, 2500)

                for _ in range(15):
                    if "accounts.google.com" in page.url:
                        on_google = True
                        break
                    await asyncio.sleep(0.5)

            if not on_google:
                if proxy and await is_turnstile_detected(page):
                    logger.warn(f"Cloudflare Turnstile terdeteksi saat sign up dengan proxy {proxy.server}! Langsung rotasi proxy...")
                    raise TurnstileDetectedException(f"Turnstile detected on Webshare register via proxy {proxy.server}")
                else:
                    await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

                if "accounts.google.com" not in page.url:
                    screenshot_path = os.path.join(screenshot_dir, f"no_google_{sanitized_email}.png")
                    await page.screenshot(path=screenshot_path)
                    raise RuntimeError("Webshare register page did not redirect to Google sign-in")

            # ── 2. Perform Google OAuth ─────────────────────────────────────
            logger.info(f"performing Google OAuth for {email}...")
            post_auth_page = await perform_google_oauth(
                page=page,
                email=account.email,
                password=account.password,
                recovery_email=account.recovery_email,
                timeout_sec=120 if proxy else 75,
                logger=logger,
            )
            page = post_auth_page
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # ── 3. Wait for redirect back to Webshare dashboard ──────────────
            logger.info("waiting for navigation back to Webshare dashboard...")
            landed = False
            start_dash = time.time()
            while time.time() - start_dash < dashboard_timeout_sec:
                cur_url = page.url
                if DASHBOARD_URL_RE.search(cur_url):
                    landed = True
                    break
                if AUTH_EXCHANGE_RE.search(cur_url):
                    logger.info("exchanging Google OAuth code on Webshare...")
                    await asyncio.sleep(1.5)
                    continue

                # Check account restriction
                content_sample = (await page.content() or "").lower()
                if "account restricted" in content_sample or "access suspended" in content_sample:
                    raise RuntimeError("ACCOUNT_RESTRICTED: Webshare account restricted by risk control")

                if proxy and await is_turnstile_detected(page):
                    logger.warn(f"Turnstile terdeteksi di dashboard dengan proxy {proxy.server}! Langsung rotasi...")
                    raise TurnstileDetectedException(f"Turnstile detected on callback via proxy {proxy.server}")

                await asyncio.sleep(1.0)

            if not landed:
                screenshot_path = os.path.join(screenshot_dir, f"no_dashboard_{sanitized_email}.png")
                await page.screenshot(path=screenshot_path)
                raise RuntimeError(f"stuck after OAuth at URL: {page.url[:120]}")

            logger.info(f"successfully landed on Webshare dashboard ({page.url[:80]})!")
            await human_delay(int(1500 * delay_mult), int(3000 * delay_mult))

            # Dismiss any onboarding modals / cookies if present
            try:
                dismiss_btn = await page.query_selector('button:has-text("Accept"), button:has-text("Got it"), button:has-text("Close"), button:has-text("Skip")')
                if dismiss_btn:
                    await dismiss_btn.click()
                    await asyncio.sleep(0.5)
            except Exception:
                pass

            # ── 4. Open Proxy List page ─────────────────────────────────────
            plan_id = None
            list_url = None

            # Check sidebar link: a[href*="/proxy/list"]
            link_el = None
            try:
                link_el = await page.wait_for_selector('a[href*="/proxy/list"]', timeout=30000)
            except Exception:
                pass

            if link_el:
                href = await link_el.get_attribute("href") or ""
                m = PLAN_ID_RE.search(href)
                if m:
                    plan_id = m.group(1)
                    list_url = f"https://dashboard.webshare.io/{plan_id}/proxy/list"
                elif href:
                    list_url = href if href.startswith("http") else f"https://dashboard.webshare.io{href}"

            if not list_url:
                # Try finding planId from current URL
                m = re.search(r"/(\d{3,})/", page.url)
                if m:
                    plan_id = m.group(1)
                    list_url = f"https://dashboard.webshare.io/{plan_id}/proxy/list"
                else:
                    list_url = "https://dashboard.webshare.io/proxy/list"

            logger.info(f"navigating to proxy list page: {list_url} (plan={plan_id or 'unknown'})...")
            await page.goto(list_url, wait_until="domcontentloaded", timeout=timeout_ms)
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # ── 5. Harvest proxies from Webshare API ─────────────────────────
            logger.info("harvesting free proxies via Webshare API...")
            collected_proxies: Dict[str, Dict[str, Any]] = {}

            # Add any proxies intercepted during navigation
            for p in intercepted_proxies:
                key = f"{p.get('proxy_address')}:{p.get('port')}"
                collected_proxies[key] = p

            deadline = time.time() + proxy_list_timeout_sec
            while time.time() < deadline and len(collected_proxies) < 10:
                # If auth_token captured, query direct proxy list API
                if auth_token:
                    # 1. Try browser in-context fetch (handles CF clearance & CORS automatically)
                    try:
                        res_data = await page.evaluate("""async (token) => {
                            try {
                                const resp = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100', {
                                    headers: {
                                        'Authorization': token,
                                        'Accept': 'application/json'
                                    }
                                });
                                if (!resp.ok) return { error: `HTTP ${resp.status}` };
                                return await resp.json();
                            } catch(e) {
                                return { error: String(e) };
                            }
                        }""", auth_token)

                        if res_data and isinstance(res_data, dict) and "results" in res_data:
                            for row in res_data.get("results", []):
                                if row.get("proxy_address") and row.get("port"):
                                    k = f"{row.get('proxy_address')}:{row.get('port')}"
                                    collected_proxies[k] = row
                    except Exception as e:
                        logger.warn(f"in-page API fetch attempt failed: {e}")

                    # 2. Try python requests as backup
                    if len(collected_proxies) < 10:
                        try:
                            resp = requests.get(
                                "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100",
                                headers={"Authorization": auth_token, "Accept": "application/json"},
                                timeout=15.0,
                            )
                            if resp.status_code == 200:
                                data = resp.json()
                                for row in data.get("results", []):
                                    if row.get("proxy_address") and row.get("port"):
                                        k = f"{row.get('proxy_address')}:{row.get('port')}"
                                        collected_proxies[k] = row
                        except Exception:
                            pass

                if len(collected_proxies) >= 10:
                    break

                logger.info(f"collected {len(collected_proxies)}/10 proxies so far, waiting for plan provisioning...")
                await asyncio.sleep(2.5)

            if len(collected_proxies) == 0:
                screenshot_path = os.path.join(screenshot_dir, f"no_proxies_{sanitized_email}.png")
                await page.screenshot(path=screenshot_path)
                raise RuntimeError("NO_PROXIES: Webshare proxy list API returned 0 proxies within timeout")

            proxy_list = list(collected_proxies.values())
            logger.info(f"harvested {len(proxy_list)} free proxies for {email}!")

            # ── 6. Save proxies & update records ────────────────────────────
            written_count = results.mark_success(email, proxy_list)
            logger.info(f"account DONE: {len(proxy_list)} proxies ({written_count} new) saved to {results.proxy_file}")

            store.upsert({
                "email": email,
                "status": FlowState.DONE,
                "proxiesCount": len(proxy_list),
                "newCount": written_count,
            })
            return True

    except TurnstileDetectedException as te:
        logger.warn(f"Cloudflare Turnstile terdeteksi saat proses akun {email}: {te}")
        raise
    except Exception as e:
        logger.error(f"failed Webshare signup for {email}: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, str(e))
        return False


def get_completed_emails(store: JsonlStore, results: WebshareResultWriter, current_state_file: str) -> Set[str]:
    completed: Set[str] = set()
    completed.update(results.get_successful_emails())
    completed.update(store.get_all_done_emails())
    if os.path.exists("state-webshare.jsonl") and os.path.abspath("state-webshare.jsonl") != os.path.abspath(current_state_file):
        try:
            alt = JsonlStore("state-webshare.jsonl")
            completed.update(alt.get_all_done_emails())
        except Exception:
            pass
    return completed


def get_failed_emails(store: JsonlStore, results: WebshareResultWriter, current_state_file: str) -> Set[str]:
    failed: Set[str] = set()
    failed.update(results.get_failed_emails())
    failed.update(store.get_all_failed_emails())
    return failed


async def main():
    setup_process_signals()
    parser = argparse.ArgumentParser(description="Webshare Free-Proxy Camoufox runner (Google OAuth + Camoufox)")
    parser.add_argument("--accounts-file", default="gsuite.txt", help="Path to gsuite accounts file")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed (visible) mode")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--proxy-file", default="", help="Path to proxy list file")
    parser.add_argument("--delay", type=float, default=15.0, help="Delay between accounts in seconds")
    parser.add_argument("--retry-failed", action="store_true", help="Retry accounts previously marked failed")
    parser.add_argument("--state-file", default="state-webshare.jsonl", help="State file")
    parser.add_argument("--output-file", default="proxy.txt", help="Output proxy list file")
    parser.add_argument("--result-success-file", default="akun-result-webshare.txt", help="Success accounts result file")
    parser.add_argument("--result-failed-file", default="akun-failed-webshare.txt", help="Failed accounts result file")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Number of parallel workers")
    parser.add_argument("--limit", "-l", "-n", type=int, default=0, help="Max accounts to process")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default="human", help="Cadence pace")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-webshare", help="Directory for screenshots")
    parser.add_argument("--proxy-format", choices=["url", "webshare"], default="url", help="Format for saved proxy lines")
    parser.add_argument("--reuse-proxy", action="store_true", help="Rotate/reuse proxies in pool")

    args = parser.parse_args()
    logger = create_logger("webshare")

    # Load proxies if enabled
    proxies: List[Proxy] = []
    if not args.no_proxy:
        proxy_path = args.proxy_file
        if not proxy_path:
            for candidate in ["signup-proxy.txt", "proxy-live.txt", "proxy.txt"]:
                if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
                    proxy_path = candidate
                    break
        if proxy_path and os.path.exists(proxy_path):
            proxies = load_proxies(proxy_path)
            logger.info(f"Loaded {len(proxies)} proxies from {proxy_path}")
        else:
            logger.info("No proxy file found; proceeding with direct connection.")

    proxy_pool = ProxyPool(proxies, reuse_proxy=args.reuse_proxy) if proxies else None

    # Load Google Accounts
    if not os.path.exists(args.accounts_file):
        logger.error(f"Accounts file {args.accounts_file} not found!")
        sys.exit(1)

    accounts = load_accounts(args.accounts_file)
    logger.info(f"Loaded {len(accounts)} accounts from {args.accounts_file}")

    store = JsonlStore(args.state_file)
    results = WebshareResultWriter(
        success_file=args.result_success_file,
        failed_file=args.result_failed_file,
        proxy_file=args.output_file,
        proxy_format=args.proxy_format,
    )

    completed_emails = get_completed_emails(store, results, args.state_file)
    failed_emails = get_failed_emails(store, results, args.state_file)

    eligible_accounts = [acc for acc in accounts if acc.email.lower() not in completed_emails]
    if not args.retry_failed:
        eligible_accounts = [
            acc for acc in eligible_accounts
            if acc.email.lower() not in failed_emails and not store.is_restricted_or_banned(acc.email)
        ]
    else:
        logger.info("Retry mode active: prioritizing previously failed accounts.")
        eligible_accounts.sort(key=lambda acc: 0 if acc.email.lower() in failed_emails else 1)

    if not eligible_accounts:
        logger.info("All accounts have already been completed successfully! Nothing to do.")
        return

    target_count = min(args.limit, len(eligible_accounts)) if args.limit > 0 else len(eligible_accounts)
    worker_count = max(1, min(args.workers, target_count, len(eligible_accounts)))
    logger.info(
        f"Webshare Camoufox runner started: total={len(accounts)}, completed={len(accounts) - len(eligible_accounts)}, "
        f"todo={len(eligible_accounts)}, target={target_count}, workers={worker_count}, proxies={len(proxies)}"
    )

    if args.dry_run:
        logger.info(f"dry-run: next account(s) to process: {[a.email for a in eligible_accounts[:target_count]]}")
        return

    processed = 0
    success_count = 0
    account_queue = deque(eligible_accounts)
    lock = asyncio.Lock()

    async def worker(worker_id: int):
        nonlocal processed, success_count
        while True:
            account: Optional[Account] = None
            proxy: Optional[Proxy] = None

            async with lock:
                if success_count >= target_count or processed >= target_count or not account_queue:
                    break
                account = account_queue.popleft()
                if not args.no_proxy and proxy_pool:
                    proxy = proxy_pool.get_next_proxy()
                processed += 1

            if not account:
                break

            acc_logger = create_logger(f"w{worker_id}:{account.email}")
            turnstile_detected = False
            ok = False

            try:
                ok = await run_single_account(
                    account=account,
                    proxy=proxy,
                    store=store,
                    results=results,
                    headed=args.headed,
                    screenshot_dir=args.screenshot_dir,
                    logger=acc_logger,
                    pace=args.pace,
                    proxy_format=args.proxy_format,
                )
            except TurnstileDetectedException as te:
                ok = False
                turnstile_detected = True
                acc_logger.warn(f"Turnstile detected with proxy {proxy.server if proxy else 'direct'}: {te}")

            async with lock:
                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, success=ok)

                if ok:
                    success_count += 1
                    logger.info(f"Progress Webshare: {success_count}/{target_count} sukses ({processed}/{target_count} diproses)")
                elif turnstile_detected:
                    logger.info(f"Worker #{worker_id}: Turnstile pada proxy untuk {account.email}. Menunda akun ke antrean...")
                    account_queue.append(account)

            if args.delay > 0 and (success_count < target_count and processed < target_count):
                await asyncio.sleep(args.delay)

    if worker_count > 1:
        await asyncio.gather(*(worker(i + 1) for i in range(worker_count)))
    else:
        await worker(1)

    logger.info(f"Webshare batch finished: {success_count}/{target_count} accounts harvested ({processed} attempts).")


if __name__ == "__main__":
    asyncio.run(main())
