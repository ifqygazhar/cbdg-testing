#!/usr/bin/env python3
"""
GroqCloud Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on GroqCloud using TempMail-Pro (magic link auth),
handles Cloudflare Turnstile, generates API keys, and saves tokens to apikey-groqcloud.txt.
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
from urllib.parse import urlparse, parse_qs

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
)

API_KEY_RE = re.compile(r"gsk_[A-Za-z0-9_\-]{20,}")
MAGIC_LINK_RE = re.compile(r"https://(?:[a-zA-Z0-9_\-\.]+\.)?stytch\.com/v1/magic_links/redirect\?[^\s\"'<>]+")

DEFAULT_SIGNUP_URL = "https://console.groq.com/home"
HOME_URL = "https://console.groq.com/home"
KEYS_URL = "https://console.groq.com/keys"

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
    password: Optional[str],
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    temp_mail: TempMailClient,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
) -> bool:
    logger.info(f"starting GroqCloud registration for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
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

            # Log active anonymous fingerprint
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up / Home ───────────────────────────────
            logger.info(f"navigating to {DEFAULT_SIGNUP_URL}")
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # Dismiss cookie banner if present
            try:
                cookie_btn = await page.query_selector('button:has-text("Accept all"), button:has-text("Accept"), button.accept_all')
                if cookie_btn:
                    await cookie_btn.click()
                    await human_delay(600, 1200)
            except Exception:
                pass

            # ── 2. Fill Email and Request Magic Link ────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.SIGNUP})
            logger.info("typing email address into signup form...")

            email_input = await page.wait_for_selector(
                'input#email-input, input[name="email"], input[type="email"]',
                timeout=15000,
            )
            if not email_input:
                raise RuntimeError("Could not find email input on GroqCloud signup page")

            await human_type(
                page,
                'input#email-input, input[name="email"], input[type="email"]',
                email,
                min_delay_ms=50,
                max_delay_ms=115,
            )

            # Natural human pause before clicking Continue
            await human_delay(int(1200 * delay_mult), int(2200 * delay_mult))

            submit_btn = await page.wait_for_selector(
                'button[type="submit"]:has-text("Continue with email"), button:has-text("Continue with email"), button[type="submit"]',
                timeout=10000,
            )
            if not submit_btn:
                raise RuntimeError("Could not find Continue with email button")

            logger.info("clicking Continue with email button...")
            await submit_btn.click()
            await human_delay(1500, 2500)

            # Check for 'Check your email' confirmation
            store.upsert({"email": email, "status": "CHECK_EMAIL"})
            check_email_confirmed = False
            for _ in range(20):
                text = await page.evaluate("() => document.body.innerText || ''")
                if re.search(r"check your email|an email was sent", text, re.I):
                    check_email_confirmed = True
                    break
                await asyncio.sleep(0.5)

            if check_email_confirmed:
                logger.info("'Check your email' confirmed on page.")
            else:
                logger.warn("Did not explicitly detect 'Check your email' text, checking inbox anyway...")

            # ── 3. Poll TempMail for Stytch Magic Link ──────────────────────
            logger.info("waiting for magic link email from TempMail...")
            magic_url = await temp_mail.wait_for_verification_link(
                address=email,
                timeout_sec=75,
                interval_sec=2.5,
                filter_sender="",
                link_pattern=MAGIC_LINK_RE,
            )
            logger.info(f"magic link received: {magic_url}")

            store.upsert({"email": email, "status": "MAGIC_LINK", "magicLink": magic_url})

            # ── 4. Authenticate via Magic Link ──────────────────────────────
            logger.info("navigating to magic link...")

            # Track network response for signupb2b and telemetry
            signup_error_info = None
            signup_succeeded = False

            async def handle_response(response):
                nonlocal signup_error_info, signup_succeeded
                resp_url = response.url
                if "signupb2b" in resp_url or "/user/profile/signupb2b" in resp_url:
                    status = response.status
                    try:
                        data = await response.json()
                        err_msg = data.get("error", {}).get("message") or str(data)
                    except Exception:
                        try:
                            err_msg = await response.text()
                        except Exception:
                            err_msg = ""
                    if status >= 400:
                        signup_error_info = f"HTTP {status}: {err_msg}"
                        logger.warn(f"GroqCloud signupb2b backend rejected request: {signup_error_info}")
                    else:
                        signup_succeeded = True
                        logger.info(f"GroqCloud signupb2b accepted by backend: HTTP {status}")
                elif "gste.groq.io" in resp_url and response.status >= 400:
                    logger.warn(f"Stytch DFP telemetry error: HTTP {response.status}")

            page.on("response", handle_response)

            await page.goto(magic_url, wait_until="domcontentloaded")
            await human_delay(int(3000 * delay_mult), int(5000 * delay_mult))

            # Wait until redirected back to console.groq.com
            authenticated = False
            for _ in range(35):
                if "console.groq.com" in page.url and "stytch.com" not in page.url and "redirect-error" not in page.url:
                    authenticated = True
                    break
                if "redirect-error" in page.url:
                    break
                await asyncio.sleep(0.5)

            if not authenticated or "redirect-error" in page.url:
                # Fallback: extract token and attempt direct auth navigation on console.groq.com
                parsed_magic = urlparse(magic_url)
                qs = parse_qs(parsed_magic.query)
                token = qs.get("token", [""])[0]
                token_type = qs.get("stytch_token_type", ["discovery"])[0]
                if token:
                    direct_auth_url = f"https://console.groq.com/authenticate?stytch_redirect_type=login&stytch_token_type={token_type}&token={token}"
                    logger.info("Stytch DFP intercepted or pending, attempting direct Groq authentication...")
                    await page.goto(direct_auth_url, wait_until="domcontentloaded")
                    await human_delay(int(2500 * delay_mult), int(4000 * delay_mult))
                    for _ in range(30):
                        if "console.groq.com" in page.url and "stytch.com" not in page.url and "redirect-error" not in page.url:
                            authenticated = True
                            break
                        await asyncio.sleep(0.5)

            if "redirect-error" in page.url or not authenticated:
                raise RuntimeError(f"Stytch magic link redirect error: {page.url}")

            logger.info(f"magic link login successful, current URL: {page.url}")

            # ── 5. Wait for Organization Creation & Dashboard Home Landing ───
            store.upsert({"email": email, "status": "CREATING_ORGANIZATION"})
            logger.info("waiting for GroqCloud automatic organization creation to complete and land on home dashboard...")

            home_ready = False
            for attempt in range(60):  # wait up to 60 seconds
                curr_url = page.url

                # Condition A: Redirected to /home (matches dashboard-home.html)
                if "/home" in curr_url and "console.groq.com" in curr_url and "stytch.com" not in curr_url:
                    home_ready = True
                    logger.info(f"GroqCloud successfully landed on dashboard home: {curr_url}")
                    break

                # Condition B: Dashboard navigation or organization selector mounted
                try:
                    dashboard_el = await page.query_selector(
                        '[data-testid="organization-selector"], [data-testid="project-selector"], a[href="/keys"]'
                    )
                    if dashboard_el:
                        home_ready = True
                        logger.info(f"GroqCloud organization and dashboard elements active on page ({curr_url}).")
                        break
                except Exception:
                    pass

                # Condition C: Detect rejection / page reverting back to email input (matches stuck.html)
                try:
                    reverted_input = await page.query_selector('input#email-input, button:has-text("Continue with email")')
                    body_text_curr = await page.evaluate("() => document.body.innerText || ''")
                    if reverted_input and "creating your organization" not in body_text_curr.lower():
                        # The organization creation failed and React unmounted the loading state back to email login
                        rejection_reason = signup_error_info or "Backend GroqCloud menolak pembuatan organisasi baru (form kembali ke input email)"
                        raise RuntimeError(
                            f"GroqCloud organization creation gagal dan kembali ke halaman input email: {rejection_reason}. "
                            f"Penyebab: IP terkena Anti-Abuse / Risk Control / Rate Limit GroqCloud (terlalu banyak registrasi dari 1 IP tanpa jeda/proxy). "
                            f"Solusi: Gunakan proxy hidup dari proxy-live.txt ('Otomatis (proxy hidup bergiliran)') atau beri jeda waktu."
                        )
                except RuntimeError:
                    raise
                except Exception:
                    pass

                # Log periodic status if still on "Creating your organization..."
                try:
                    body_text = await page.evaluate("() => document.body.innerText || ''")
                    if "creating your organization" in body_text.lower():
                        if attempt % 5 == 0:
                            logger.info("still creating organization on GroqCloud...")
                except Exception:
                    pass

                await asyncio.sleep(1)

            # Ensure we are on dashboard home and session is settled
            if not home_ready:
                if signup_error_info:
                    raise RuntimeError(
                        f"GroqCloud organization creation gagal: {signup_error_info}. "
                        f"Penyebab: IP terkena Anti-Abuse / Risk Control / Rate Limit GroqCloud. Gunakan proxy dari proxy-live.txt."
                    )
                logger.info(f"Navigating to dashboard home ({HOME_URL}) to confirm active organization session...")
                await page.goto(HOME_URL, wait_until="domcontentloaded")
                await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))
                if "authenticate" in page.url or await page.query_selector('input#email-input'):
                    raise RuntimeError(
                        "GroqCloud sesi belum terautentikasi (dashboard home mengalihkan kembali ke login). "
                        "Pembuatan organisasi gagal diproses backend."
                    )
            else:
                await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # Confirm dashboard home state
            store.upsert({"email": email, "status": "DASHBOARD"})
            logger.info(f"GroqCloud dashboard home confirmed at {page.url} with active organization!")

            # ── 6. Navigate from Dashboard Home to API Keys page ────────────
            store.upsert({"email": email, "status": "KEYS_PAGE"})
            # From dashboard home, click the API Keys link in the sidebar/navigation
            keys_link = await page.query_selector('a[href="/keys"]')
            if keys_link:
                logger.info("navigating from dashboard home to API Keys page via navigation link...")
                await keys_link.click()
                await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))

            # Fallback or ensure we are on /keys
            if "/keys" not in page.url:
                logger.info(f"navigating directly to {KEYS_URL}...")
                await page.goto(KEYS_URL, wait_until="domcontentloaded")
                await human_delay(int(2000 * delay_mult), int(3500 * delay_mult))

            # Dismiss any cookie banner on keys page (standard or custom Datagrail banner)
            try:
                cookie_btn = await page.query_selector('button:has-text("Accept all"), button:has-text("Accept"), button.accept_all')
                if cookie_btn:
                    await cookie_btn.click()
                    await human_delay(500, 1000)
                await page.evaluate("""() => {
                    const banners = document.querySelectorAll('.dg-consent-banner');
                    for (const b of banners) {
                        const root = b.shadowRoot || b;
                        const btn = root.querySelector('.accept_all, button');
                        if (btn) btn.click();
                    }
                }""")
            except Exception:
                pass

            # ── 7. Open Create API Key Modal ────────────────────────────────
            store.upsert({"email": email, "status": FlowState.API_KEY})
            logger.info("clicking Create API Key button...")
            create_btn = await page.wait_for_selector(
                'button[data-testid="keys-page-create-button"], button:has-text("Create API Key")',
                timeout=30000,
            )
            if not create_btn:
                raise RuntimeError("Create API Key button not found on /keys")

            await create_btn.click()
            await human_delay(1000, 1800)

            # ── 8. Fill Display Name ────────────────────────────────────────
            label = f"App-groq-{random.randint(100, 999)}"
            logger.info(f"typing key display name: {label}...")
            name_input = await page.wait_for_selector(
                'input[data-testid="key-name-input"], input[name="keyName"]',
                timeout=10000,
            )
            if not name_input:
                raise RuntimeError("Key name input not found in Create API Key modal")

            await human_type(
                page,
                'input[data-testid="key-name-input"], input[name="keyName"]',
                label,
                min_delay_ms=45,
                max_delay_ms=90,
            )
            await human_delay(800, 1500)

            # ── 9. Resolve Cloudflare Turnstile & Submit ─────────────────────
            logger.info("checking and resolving Cloudflare Turnstile security challenge...")
            await resolve_turnstile_if_present(page, timeout_sec=25, logger=logger)

            # Wait for Submit button to appear and become clickable
            logger.info("waiting for Submit button to become active...")
            submit_key_btn = None
            for _ in range(30):
                # Trigger another turnstile check if still pending
                await resolve_turnstile_if_present(page, timeout_sec=2, logger=None)
                btn = await page.query_selector('button[data-testid="key-form-submit-button"], button[type="submit"]')
                if btn:
                    is_ready = await page.evaluate("""(b) => {
                        if (!b) return false;
                        if (b.disabled || b.hasAttribute('disabled')) return false;
                        const r = b.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }""", btn)
                    if is_ready:
                        submit_key_btn = btn
                        break
                await asyncio.sleep(1)

            if not submit_key_btn:
                raise RuntimeError("Submit button did not appear (Cloudflare Turnstile verification may have timed out)")

            logger.info("clicking Submit key creation button...")
            await submit_key_btn.click()
            await human_delay(2000, 3500)

            # ── 10. Extract API Key ──────────────────────────────────────────
            logger.info("extracting generated GroqCloud API key...")
            api_key = None
            for _ in range(25):
                val = await page.evaluate("""() => {
                    const inp = document.querySelector('input[data-testid="show-key-input"]');
                    if (inp && inp.value) return inp.value.trim();
                    const code = document.querySelector('code');
                    if (code && code.textContent) return code.textContent.trim();
                    return null;
                }""")
                if val and API_KEY_RE.search(val):
                    api_key = API_KEY_RE.search(val).group(0)
                    break

                body_text = await page.evaluate("() => document.body.innerText || ''")
                m = API_KEY_RE.search(body_text)
                if m:
                    api_key = m.group(0)
                    break

                await asyncio.sleep(0.5)

            if not api_key:
                raise RuntimeError("Failed to extract GroqCloud API key from modal dialog")

            logger.info(f"GroqCloud API key obtained successfully: {api_key[:12]}...")

            # ── 11. Record Success ──────────────────────────────────────────
            store.upsert({
                "email": email,
                "password": password,
                "status": FlowState.DONE,
                "apiKey": api_key,
                "magicLink": magic_url,
                "updatedAt": int(time.time() * 1000),
            })
            results.mark_success(email=email, password=password or "", api_key=api_key)
            return True

    except Exception as e:
        err_msg = str(e)
        logger.error(f"GroqCloud registration failed for {email}: {err_msg}")
        try:
            if browser_ctx and page:
                shot_path = os.path.join(screenshot_dir, f"fail_{sanitized_email}.png")
                await page.screenshot(path=shot_path)
                logger.info(f"saved failure screenshot to {shot_path}")
        except Exception:
            pass

        store.upsert({
            "email": email,
            "status": FlowState.FAILED,
            "notes": err_msg,
            "updatedAt": int(time.time() * 1000),
        })
        results.mark_failed(email=email, reason=err_msg)
        return False


async def main_async():
    parser = argparse.ArgumentParser(description="GroqCloud Camoufox Runner")
    parser.add_argument("--headed", action="store_true", help="Launch visible browser window")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxies")
    parser.add_argument("--proxy-file", default=None, help="Path to proxy file")
    parser.add_argument("--accounts-file", default=None, help="Path to seed accounts file")
    parser.add_argument("--output-file", default=None, help="Additional output file for API keys")
    parser.add_argument("--state-file", default="state-groqcloud.jsonl", help="Crash-safe JSONL state file")
    parser.add_argument("--limit", type=int, default=1, help="Target number of successful accounts")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between accounts in seconds")
    parser.add_argument("--workers", type=int, default=1, help="Concurrent browser workers")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--domain", default="ifqy.net", help="TempMail domain")
    parser.add_argument("--password", default="torabikA1###########", help="Default password for account records")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default=os.getenv("PACE", "human"), help="Typing cadence")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-groqcloud", help="Directory for failure screenshots")
    args = parser.parse_args()

    # Resolve proxies file
    proxy_file = args.proxy_file
    if not proxy_file and not args.no_proxy:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    # Resolve output files
    key_files = ["apikey-groqcloud.txt"]
    if os.path.exists("groqcloud-dataset"):
        key_files.append("groqcloud-dataset/apikey-groqcloud.txt")
    if args.output_file and args.output_file not in key_files:
        key_files.append(args.output_file)

    proxies = load_proxies(proxy_file) if (proxy_file and not args.no_proxy) else []
    temp_mail = TempMailClient(default_domain=args.domain)

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file="akun-result-groqcloud.txt",
        account_failed_file="akun-failed-groqcloud.txt",
    )

    logger = create_logger()
    logger.info(f"GroqCloud Camoufox runner started (pace={args.pace}, workers={args.workers}). Proxies loaded: {len(proxies)} (proxy_mode={'no-proxy' if args.no_proxy or not proxies else 'active'})")

    if args.dry_run:
        logger.info("dry-run: config validated (no browser launched)")
        return

    proxy_pool = SmartProxyPool(proxies) if proxies else None
    count = args.limit if args.limit > 0 else (len(proxies) if proxies else 1)
    worker_count = max(1, min(args.workers, count))
    logger.info(f"Planning to process target {count} account(s) using domain @{args.domain} with {worker_count} parallel worker(s)")

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
                        logger.warn(f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted.")
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

    logger.info(f"GroqCloud Camoufox batch finished: {success_count}/{count} target achieved ({processed} total attempts).")


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
