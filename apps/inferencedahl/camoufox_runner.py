#!/usr/bin/env python3
"""
Inference Dahl Global Camoufox Runner (Python + Camoufox / Firefox engine)
Registers on https://inference.dahl.global/ using the website's auto-generated username,
extracts the 32-character fingerprint and dahl_ API key, saves fingerprint:apikey to
akun-result-inferencedahl.txt and apikey to apikey-inferencedahl.txt, then navigates to
https://inference.dahl.global/account and allocates Max (100M) tokens to the API key.
"""

import argparse
import asyncio
import concurrent.futures
from collections import deque
import os
import random
import re
import sys
import time
from typing import Optional, List, Dict, Any, Tuple, Union, Set
from urllib.parse import urlparse

import requests
from playwright.async_api import Page

# Ensure parent directory is in sys.path so packages.camoufox_core can be imported
workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if workspace_root not in sys.path:
    sys.path.insert(0, workspace_root)

from packages.camoufox_core import (
    launch_camoufox,
    get_browser_fingerprint_info,
    human_delay,
    setup_process_signals,
    kill_descendant_processes,
    cleanup_leftover_browser_processes,
    cleanup_temp_profiles,
    get_vps_system_status,
    Proxy,
    load_proxies,
    JsonlStore,
    ResultWriter,
    FlowState,
    create_logger,
    Logger,
    resolve_turnstile_if_present,
    setup_turnstile_interceptor,
    TurnstileFailedException,
)

FINGERPRINT_RE = re.compile(r"\b[a-f0-9]{32}\b", re.IGNORECASE)
API_KEY_RE = re.compile(r"\bdahl_[A-Za-z0-9_\-]{16,}\b")
DEMO_LANDING_KEY = "dahl_9iiiaUahAszFP1odpw1bvmuda8qpBGFkH"

DEFAULT_LANDING_URL = "https://inference.dahl.global/"
DEFAULT_ACCOUNT_URL = "https://inference.dahl.global/account"


def is_valid_dahl_api_key(cand: Optional[str]) -> bool:
    if not cand:
        return False
    t = cand.strip()
    if t == DEMO_LANDING_KEY:
        return False
    if "…" in t or "..." in t:
        return False
    return bool(API_KEY_RE.fullmatch(t) or API_KEY_RE.search(t))


def extract_clean_dahl_key(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    for m in API_KEY_RE.finditer(text):
        val = m.group(0)
        if val != DEMO_LANDING_KEY and "…" not in val and "..." not in val:
            return val
    return None


def extract_proxy_address(proxy_str: str) -> str:
    try:
        u = proxy_str if "://" in proxy_str else f"http://{proxy_str}"
        return urlparse(u).hostname or proxy_str
    except Exception:
        return proxy_str


def check_proxy_single_sync(
    proxy: Proxy,
    target_url: str = DEFAULT_LANDING_URL,
    timeout_sec: float = 6.0,
) -> Tuple[Proxy, bool, Union[int, str], float]:
    """
    Directly probes a proxy against Inference Dahl before opening the browser.
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
    target_url: str = DEFAULT_LANDING_URL,
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


class InferenceDahlProxyPool:
    """Manages fresh and verified proxies with concurrent batch pre-checking.
    - Bad/rejected proxies are permanently discarded.
    - Successful proxies are preserved in a reusable pool and recycled when fresh proxies run out.
    - Proactively probes candidate proxies against Inference Dahl before opening the browser.
      Any proxy that times out or returns non-200 is skipped immediately without launching Camoufox.
    """

    def __init__(self, proxies: List[Proxy], reuse_proxy: bool = False):
        self.fresh_proxies: deque[Proxy] = deque(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: Set[str] = set()
        self.reuse_proxy: bool = reuse_proxy
        self._lock = asyncio.Lock()

    def address_of(self, proxy: Proxy) -> str:
        return extract_proxy_address(proxy.server)

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
        target_url: str = DEFAULT_LANDING_URL,
        timeout_sec: float = 6.0,
        batch_size: int = 15,
        logger: Optional[Logger] = None,
        enable_precheck: bool = True,
    ) -> Optional[Proxy]:
        """
        Asynchronously retrieves the next proxy that is guaranteed to return HTTP 200 on Inference Dahl.
        Candidate fresh proxies are tested concurrently in batches of `batch_size`.
        Any proxy that times out or returns non-200 is immediately skipped and discarded.
        """
        if not enable_precheck:
            async with self._lock:
                return self.get_next_proxy()

        # 1. If reuse_proxy is active and we have proven good proxies, reuse good proxy immediately
        async with self._lock:
            if self.reuse_proxy and self.good_proxies:
                chosen = self.good_proxies.pop(0)
                self.good_proxies.append(chosen)
                return chosen

        # 2. Loop through fresh proxies in parallel batches until an HTTP 200 proxy is found
        while True:
            candidates: List[Proxy] = []
            async with self._lock:
                # If good_proxies has accumulated candidates from other batch probes, consume them
                if self.good_proxies:
                    chosen = self.good_proxies.pop(0)
                    if self.reuse_proxy:
                        self.good_proxies.append(chosen)
                    return chosen

                while self.fresh_proxies and len(candidates) < batch_size:
                    cand = self.fresh_proxies.popleft()
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

            if logger:
                logger.info(
                    f"🔍 Pre-checking batch of {len(candidates)} candidate proxies against Inference Dahl "
                    f"(HTTP 200, timeout={timeout_sec}s)... (Fresh remaining: {len(self.fresh_proxies)}, Good pool: {len(self.good_proxies)})"
                )

            results = await asyncio.to_thread(
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
                    async with self._lock:
                        self.bad_addresses.add(addr)
                    bad_count += 1

            if bad_count > 0 and logger:
                logger.info(f"⏭️ Discarded {bad_count} dead/non-200 proxies from batch.")

            if good_batch:
                chosen = good_batch[0]
                if len(good_batch) > 1:
                    async with self._lock:
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

    @property
    def good_count(self) -> int:
        return len(self.good_proxies)


async def setup_dahl_credential_hooks(page: Page) -> Dict[str, Any]:
    """
    Hooks network responses (/v1/auth/signup, /v1/account/keys), navigator.clipboard.writeText,
    and Blob creation ("Download as .txt") to capture the 32-char fingerprint and full dahl_ API key.
    """
    captured: Dict[str, Any] = {
        "fingerprint": None,
        "api_key": None,
        "username": None,
    }

    async def handle_response(response):
        try:
            url = response.url
            if "/v1/auth/signup" in url and response.request.method == "POST" and response.status == 200:
                data = await response.json()
                fp = data.get("fingerprint") or ""
                if FINGERPRINT_RE.search(fp):
                    captured["fingerprint"] = FINGERPRINT_RE.search(fp).group(0)
                api_obj = data.get("api_key") or {}
                tok = api_obj.get("token") if isinstance(api_obj, dict) else (data.get("apiKey") or data.get("token") or "")
                clean_k = extract_clean_dahl_key(tok)
                if clean_k:
                    captured["api_key"] = clean_k
                user_obj = data.get("user") or {}
                if isinstance(user_obj, dict) and user_obj.get("username"):
                    captured["username"] = user_obj.get("username")
            elif "/v1/account/keys" in url and response.status == 200:
                data = await response.json()
                keys_list = data.get("keys") if isinstance(data.get("keys"), list) else ([data.get("key")] if data.get("key") else [])
                for k in keys_list:
                    if isinstance(k, dict):
                        clean_k = extract_clean_dahl_key(k.get("token"))
                        if clean_k:
                            captured["api_key"] = clean_k
                            break
        except Exception:
            pass

    page.on("response", handle_response)

    init_js = """() => {
        window.__dahl_clipboard = [];
        window.__dahl_blobs = [];
        try {
            if (navigator.clipboard) {
                const origWrite = navigator.clipboard.writeText ? navigator.clipboard.writeText.bind(navigator.clipboard) : null;
                navigator.clipboard.writeText = async function(text) {
                    window.__dahl_clipboard.push(String(text));
                    if (origWrite) {
                        try { return await origWrite(text); } catch (e) {}
                    }
                    return Promise.resolve();
                };
            }
        } catch (e) {}
        try {
            const OrigBlob = window.Blob;
            window.Blob = function(parts, options) {
                try {
                    if (Array.isArray(parts)) {
                        window.__dahl_blobs.push(parts.map(p => String(p)).join("\\n"));
                    }
                } catch (e) {}
                return new OrigBlob(parts, options);
            };
            window.Blob.prototype = OrigBlob.prototype;
        } catch (e) {}
    }"""
    await page.add_init_script(init_js)
    try:
        await page.evaluate(init_js)
    except Exception:
        pass

    return captured


async def allocate_max_tokens_on_account(
    page: Page,
    captured: Dict[str, Any],
    current_api_key: Optional[str],
    logger: Logger,
    pace: str = "fast",
) -> Tuple[bool, Optional[str]]:
    """
    On https://inference.dahl.global/account:
    1. Ensures API keys section is visible.
    2. Reveals/extracts full API key if not already captured.
    3. Clicks 'Allocate' button on the key card.
    4. In 'Allocate to key' modal popup, clicks 'Max' then clicks 'Allocate'.
    5. Verifies the key card status shows 'Active' and '100M' ('100M/100M').
    """
    if "/account" not in page.url:
        logger.info(f"navigating to {DEFAULT_ACCOUNT_URL}...")
        await page.goto(DEFAULT_ACCOUNT_URL, wait_until="domcontentloaded", timeout=35000)

    await human_delay(1200, 2000, pace=pace)

    api_keys_sec = page.locator('section[aria-label="API keys"]').first
    await api_keys_sec.wait_for(state="visible", timeout=25000)
    await human_delay(600, 1000, pace=pace)

    api_key = current_api_key or captured.get("api_key")

    # Fallback: Reveal & Copy key on /account if not yet captured
    if not is_valid_dahl_api_key(api_key):
        logger.info("revealing full API key from /account dashboard...")
        reveal_btn = api_keys_sec.locator('button[aria-label="Reveal"]').first
        if await reveal_btn.count() > 0 and await reveal_btn.is_visible():
            await reveal_btn.click()
            await human_delay(300, 600, pace=pace)

        copy_btn = api_keys_sec.locator('button[aria-label="Copy"]').first
        if await copy_btn.count() > 0 and await copy_btn.is_visible():
            await copy_btn.click()
            await human_delay(300, 500, pace=pace)

        code_el = api_keys_sec.locator("code").first
        if await code_el.count() > 0:
            code_txt = (await code_el.text_content() or "").strip()
            cand = extract_clean_dahl_key(code_txt)
            if cand:
                api_key = cand

        if not is_valid_dahl_api_key(api_key):
            clip_list = await page.evaluate("() => window.__dahl_clipboard || []")
            for item in clip_list:
                cand = extract_clean_dahl_key(str(item))
                if cand:
                    api_key = cand
                    break

        if not is_valid_dahl_api_key(api_key) and is_valid_dahl_api_key(captured.get("api_key")):
            api_key = captured["api_key"]

    # Check if already Active with 100M allocated (idempotent check)
    sec_text = await api_keys_sec.text_content() or ""
    if "Active" in sec_text and ("100M/100M" in sec_text or "100.0M/100.0M" in sec_text):
        logger.info("✅ API key is already Active with 100M/100M tokens allocated!")
        return True, api_key

    # Click 'Allocate' button on the key card
    logger.info("clicking 'Allocate' button on API key card...")
    allocate_card_btn = api_keys_sec.locator('button[type="button"]:has-text("Allocate")').first
    await allocate_card_btn.wait_for(state="visible", timeout=15000)
    await allocate_card_btn.click()
    await human_delay(600, 1200, pace=pace)

    # Wait for 'Allocate to key' modal popup
    logger.info("waiting for 'Allocate to key' modal popup...")
    alloc_dialog = page.locator('[role="dialog"]:has-text("Allocate to key")').first
    await alloc_dialog.wait_for(state="visible", timeout=15000)
    await human_delay(400, 800, pace=pace)

    # Click 'Max' button inside modal
    logger.info("clicking 'Max' button in Allocate modal...")
    max_btn = alloc_dialog.locator('button[type="button"]:has-text("Max")').first
    await max_btn.wait_for(state="visible", timeout=10000)
    await max_btn.click()
    await human_delay(500, 900, pace=pace)

    # Wait for modal's 'Allocate' submit button to become enabled and click it
    logger.info("clicking 'Allocate' confirm button in modal...")
    confirm_alloc_btn = alloc_dialog.locator('button[type="button"]:has-text("Allocate"):not([disabled])').first
    await confirm_alloc_btn.wait_for(state="visible", timeout=10000)
    await confirm_alloc_btn.click()

    # Wait for allocation to reflect on the API keys section: 'Active' and '100M' ('100M/100M')
    logger.info("verifying 'Active' status and '100M' token allocation on dashboard...")
    t0 = time.time()
    verified = False
    while time.time() - t0 < 18.0:
        sec_text = await api_keys_sec.text_content() or ""
        if "Active" in sec_text and ("100M" in sec_text or "100.0M" in sec_text):
            verified = True
            break
        await asyncio.sleep(0.5)

    if not verified:
        raise RuntimeError("Token allocation verification timed out ('Active' and '100M' not detected on key card)")

    logger.info("✅ Token allocation verified: Key is Active with 100M/100M tokens!")
    return True, api_key


async def run_inferencedahl_single(
    session_id: str,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    args: argparse.Namespace,
    logger: Logger,
) -> bool:
    store.upsert({
        "email": session_id,
        "status": FlowState.PENDING,
        "proxy": proxy.server if proxy else "direct",
        "updatedAt": int(time.time() * 1000),
    })

    screenshot_dir = getattr(args, "screenshot_dir", "screenshots-inferencedahl")
    os.makedirs(screenshot_dir, exist_ok=True)

    browser_ctx = await launch_camoufox(
        headless=not args.headed,
        proxy=proxy,
        geoip=True,
    )

    page: Optional[Page] = None
    context = None
    saved_to_files = False
    fingerprint_val: Optional[str] = None
    api_key_val: Optional[str] = None

    async with browser_ctx as browser:
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()
        page.set_default_timeout(35000)

        fp_info = await get_browser_fingerprint_info(page)
        if fp_info:
            gpu_tag = f" | GPU={fp_info.get('renderer')[:35]}" if fp_info.get("renderer") and fp_info.get("renderer") != "unknown" else ""
            logger.info(
                f"🛡️ Camoufox Fingerprint: OS={fp_info.get('platform')} | Screen={fp_info.get('screen')} | "
                f"Viewport={fp_info.get('viewport')} | Cores={fp_info.get('cores')}{gpu_tag} | UA={fp_info.get('ua')}"
            )

        await setup_turnstile_interceptor(page)
        captured = await setup_dahl_credential_hooks(page)

        try:
            logger.info(f"navigating to {DEFAULT_LANDING_URL}")
            store.upsert({"email": session_id, "status": FlowState.SIGNUP, "updatedAt": int(time.time() * 1000)})
            await page.goto(DEFAULT_LANDING_URL, wait_until="domcontentloaded", timeout=40000)
            await human_delay(1200, 2200, pace=args.pace)

            # Check if Turnstile is present on landing
            await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

            # Open SIGN IN modal if not already open
            dialog = page.locator('[role="dialog"]')
            if await dialog.count() == 0 or not await dialog.first.is_visible():
                logger.info("clicking 'SIGN IN' button in navbar...")
                sign_in_btn = page.locator('a[data-auth="guest"]:has-text("SIGN IN"), a:has-text("SIGN IN")').first
                if await sign_in_btn.count() > 0 and await sign_in_btn.is_visible():
                    await sign_in_btn.click()
                    await human_delay(800, 1400, pace=args.pace)
                else:
                    logger.info(f"navigating directly to {DEFAULT_ACCOUNT_URL} to open auth modal...")
                    await page.goto(DEFAULT_ACCOUNT_URL, wait_until="domcontentloaded", timeout=35000)
                    await human_delay(1200, 2000, pace=args.pace)

            # Wait for modal dialog to be visible
            dialog = page.locator('[role="dialog"]').first
            await dialog.wait_for(state="visible", timeout=15000)
            await human_delay(400, 800, pace=args.pace)

            # Switch from 'Welcome back' (Sign in) modal to 'Create your account' modal
            username_input = page.locator("input#signup-username")
            if await username_input.count() == 0 or not await username_input.first.is_visible():
                logger.info("switching modal to 'Create your account'...")
                # The sign-in modal contains two 'Create account' buttons:
                # 1) Mobile button inside '.md:hidden' (hidden on desktop)
                # 2) Desktop button inside 'md:flex' (hidden on mobile)
                # We click the one that is actually visible
                clicked_switch = False
                vis_switch = page.locator('[role="dialog"] button:visible:has-text("Create account")')
                if await vis_switch.count() > 0:
                    try:
                        await vis_switch.first.wait_for(state="visible", timeout=8000)
                        await vis_switch.first.click()
                        clicked_switch = True
                    except Exception:
                        pass

                if not clicked_switch:
                    # Fallback via JavaScript to find any visible Create account button in dialog
                    clicked_switch = await page.evaluate("""() => {
                        const dialog = document.querySelector('[role="dialog"]') || document.body;
                        const btns = Array.from(dialog.querySelectorAll('button'));
                        const btn = btns.find(b => 
                            /create\\s*account/i.test((b.textContent || '').trim()) && 
                            b.type !== 'submit' &&
                            (b.offsetParent !== null || window.getComputedStyle(b).display !== 'none')
                        ) || btns.find(b => /create\\s*account/i.test((b.textContent || '').trim()) && b.type !== 'submit');
                        if (btn) {
                            btn.click();
                            return true;
                        }
                        return false;
                    }""")

                await human_delay(600, 1100, pace=args.pace)

            # Wait for auto-generated username input (#signup-username) and click it to enable submit button
            await username_input.first.wait_for(state="visible", timeout=15000)
            username_val = ""

            for attempt in range(1, 6):
                logger.info(f"clicking auto-generated username field (#signup-username) [attempt {attempt}]...")
                await username_input.first.click()
                await page.evaluate("""() => {
                    const inp = document.querySelector('input#signup-username');
                    if (inp) {
                        inp.focus();
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }""")
                await human_delay(500, 900, pace=args.pace)

                # Wait up to 5s for username availability check to complete and 'Create account' submit button to enable
                t_wait = time.time()
                btn_enabled = False
                while time.time() - t_wait < 5.0:
                    username_val = (await username_input.first.input_value() or "").strip()
                    btn_state = await page.evaluate("""() => {
                        const btn = document.querySelector('[role="dialog"] form button[type="submit"]');
                        if (!btn) return { exists: false, enabled: false };
                        const isDis = btn.disabled || btn.hasAttribute('disabled') || btn.classList.contains('pointer-events-none');
                        return { exists: true, enabled: !isDis };
                    }""")

                    if username_val and btn_state.get("enabled"):
                        btn_enabled = True
                        break

                    dialog_txt = await page.locator('[role="dialog"]').first.text_content() or ""
                    if "taken" in dialog_txt.lower() or "already" in dialog_txt.lower():
                        break
                    await asyncio.sleep(0.3)

                if btn_enabled:
                    break

                logger.info(f"username '{username_val}' not yet enabled/available, clicking Regenerate...")
                regen_btn = page.locator('[role="dialog"] button[aria-label="Regenerate"]').first
                if await regen_btn.count() > 0 and await regen_btn.is_visible():
                    await regen_btn.click()
                    await human_delay(600, 1000, pace=args.pace)

            logger.info(f"submitting 'Create account' with auto-generated username: {username_val}")
            submit_btn = page.locator('[role="dialog"] form button[type="submit"]:not([disabled])').first
            try:
                await submit_btn.wait_for(state="visible", timeout=10000)
                await submit_btn.click()
            except Exception:
                await page.evaluate("""() => {
                    const btn = document.querySelector('[role="dialog"] form button[type="submit"]');
                    if (btn) btn.click();
                }""")

            # Wait for 'Save your fingerprint' modal
            logger.info("waiting for 'Save your fingerprint' modal...")
            save_fp_heading = page.locator('[role="dialog"] h2:has-text("Save your fingerprint")').first
            await save_fp_heading.wait_for(state="visible", timeout=20000)
            await human_delay(600, 1200, pace=args.pace)

            # Click both Copy buttons & 'Download as .txt' in the modal to populate clipboard/Blob hooks
            await page.evaluate("""async () => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return;
                const copyBtns = Array.from(dialog.querySelectorAll('button[aria-label="Copy"]'));
                for (const b of copyBtns) {
                    b.click();
                    await new Promise(r => setTimeout(r, 150));
                }
                const dlBtn = Array.from(dialog.querySelectorAll('button')).find(
                    b => /download as \\.txt/i.test(b.textContent || '')
                );
                if (dlBtn) dlBtn.click();
            }""")
            await human_delay(400, 700, pace=args.pace)

            # Extract fingerprint and api_key from network intercept, DOM codes, clipboard hook, and Blob hook
            fingerprint_val = captured.get("fingerprint")
            api_key_val = captured.get("api_key")

            dom_data = await page.evaluate("""() => {
                const codes = Array.from(document.querySelectorAll('[role="dialog"] code')).map(c => (c.textContent || '').trim());
                const clip = window.__dahl_clipboard || [];
                const blobs = window.__dahl_blobs || [];
                return { codes, clip, blobs };
            }""")

            if not fingerprint_val:
                for src in (dom_data.get("codes", []) + dom_data.get("clip", []) + dom_data.get("blobs", [])):
                    m = FINGERPRINT_RE.search(str(src))
                    if m:
                        fingerprint_val = m.group(0)
                        break

            if not is_valid_dahl_api_key(api_key_val):
                for src in (dom_data.get("clip", []) + dom_data.get("blobs", []) + dom_data.get("codes", [])):
                    cand = extract_clean_dahl_key(str(src))
                    if cand:
                        api_key_val = cand
                        break

            if not fingerprint_val:
                ss_path = os.path.join(screenshot_dir, f"fp-extract-fail-{int(time.time())}.png")
                await page.screenshot(path=ss_path)
                raise RuntimeError(f"Failed to extract 32-character fingerprint from signup modal. Screenshot: {ss_path}")

            # Safeguard: Save fingerprint:apikey to akun-result-inferencedahl.txt and apikey to apikey-inferencedahl.txt immediately after signup!
            if is_valid_dahl_api_key(api_key_val):
                results.mark_success(email=fingerprint_val, password="", api_key=api_key_val)
                saved_to_files = True
                dataset_dir = os.path.join(workspace_root, "inference-dahl-global-dataset")
                if os.path.exists(dataset_dir):
                    try:
                        with open(os.path.join(dataset_dir, "apikey-inferencedahl.txt"), "a", encoding="utf-8") as f:
                            f.write(f"{api_key_val}\n")
                    except Exception:
                        pass
                logger.info(
                    f"💾 Saved after signup -> akun-result-inferencedahl.txt ({fingerprint_val[:8]}...:{api_key_val[:10]}...) "
                    f"& apikey-inferencedahl.txt"
                )

            # Check 'I saved my fingerprint and understand it cannot be recovered' checkbox and click Continue
            logger.info("checking 'I saved my fingerprint' checkbox and clicking 'Continue'...")
            await page.evaluate("""() => {
                const cb = document.querySelector('input.auth-checkbox[type="checkbox"]');
                if (cb && !cb.checked) {
                    cb.click();
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }""")
            checkbox = page.locator('[role="dialog"] input.auth-checkbox[type="checkbox"]').first
            if await checkbox.count() > 0 and not await checkbox.is_checked():
                try:
                    await checkbox.check(force=True)
                except Exception:
                    pass
            await human_delay(400, 800, pace=args.pace)

            continue_btn = page.locator('[role="dialog"] button:has-text("Continue"):not([disabled])').first
            try:
                await continue_btn.wait_for(state="visible", timeout=10000)
                await continue_btn.click()
            except Exception:
                await page.evaluate("""() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (!dialog) return;
                    const btn = Array.from(dialog.querySelectorAll('button')).find(
                        b => /continue/i.test((b.textContent || '').trim()) && !b.disabled
                    );
                    if (btn) btn.click();
                }""")
            await human_delay(1200, 2200, pace=args.pace)

            # Navigate to /account and allocate Max (100M) tokens to the API key
            store.upsert({
                "email": fingerprint_val,
                "username": username_val,
                "status": FlowState.DASHBOARD,
                "apiKey": api_key_val,
                "updatedAt": int(time.time() * 1000),
            })

            allocated_ok, final_api_key = await allocate_max_tokens_on_account(
                page=page,
                captured=captured,
                current_api_key=api_key_val,
                logger=logger,
                pace=args.pace,
            )

            if is_valid_dahl_api_key(final_api_key):
                api_key_val = final_api_key

            if not is_valid_dahl_api_key(api_key_val):
                ss_path = os.path.join(screenshot_dir, f"apikey-fail-{int(time.time())}.png")
                await page.screenshot(path=ss_path)
                raise RuntimeError(f"Failed to extract full dahl_ API key. Screenshot: {ss_path}")

            if not saved_to_files:
                results.mark_success(email=fingerprint_val, password="", api_key=api_key_val)
                saved_to_files = True
                dataset_dir = os.path.join(workspace_root, "inference-dahl-global-dataset")
                if os.path.exists(dataset_dir):
                    try:
                        with open(os.path.join(dataset_dir, "apikey-inferencedahl.txt"), "a", encoding="utf-8") as f:
                            f.write(f"{api_key_val}\n")
                    except Exception:
                        pass

            store.upsert({
                "email": fingerprint_val,
                "username": username_val,
                "status": FlowState.DONE,
                "apiKey": api_key_val,
                "allocated": allocated_ok,
                "updatedAt": int(time.time() * 1000),
            })

            logger.info(
                f"🎉 Successfully created Inference Dahl account (username={username_val}, "
                f"fingerprint={fingerprint_val[:8]}..., api_key={api_key_val[:12]}..., allocated=100M Active)"
            )
            return True

        except TurnstileFailedException:
            logger.error(f"❌ Turnstile Verification FAILED for {session_id} ({proxy.server if proxy else 'direct IP'}). Discarding proxy immediately.")
            store.upsert({
                "email": fingerprint_val or session_id,
                "status": FlowState.FAILED,
                "notes": "TURNSTILE_FAILED_FLAGGED_IP",
                "updatedAt": int(time.time() * 1000),
            })
            if not saved_to_files:
                results.mark_failed(fingerprint_val or session_id, "TURNSTILE_FAILED_FLAGGED_IP")
            raise

        except Exception as e:
            err_msg = str(e)
            logger.error(f"FAILED for {fingerprint_val or session_id}: {err_msg}")
            store.upsert({
                "email": fingerprint_val or session_id,
                "status": FlowState.FAILED,
                "notes": err_msg,
                "updatedAt": int(time.time() * 1000),
            })
            if not saved_to_files:
                results.mark_failed(fingerprint_val or session_id, err_msg)
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
    parser = argparse.ArgumentParser(description="Inference Dahl Global Camoufox Runner")
    parser.add_argument("--headed", action="store_true", help="Run browser in headed mode")
    parser.add_argument("--delay", type=int, default=2, help="Seconds delay between accounts")
    parser.add_argument("--state-file", default="state-inferencedahl.jsonl", help="State file path")
    parser.add_argument("--limit", type=int, default=1, help="Number of accounts to create")
    parser.add_argument("--domain", default="ifqy.net", help="Optional compatibility flag (unused)")
    parser.add_argument("--pace", choices=["fast", "human", "careful"], default="fast", help="Interaction cadence")
    parser.add_argument("--auth", default="auto", help="Optional compatibility flag")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Concurrent worker count")
    parser.add_argument("--no-proxy", action="store_true", help="Disable proxy usage and run direct")
    parser.add_argument("--with-proxy", action="store_true", help="Enable proxy usage")
    parser.add_argument("--proxy-file", default=None, help="Proxy file path (default: proxy-live.txt / proxy.txt)")
    parser.add_argument("--reuse-proxy", action="store_true", help="Allow recycling proxies")
    parser.add_argument("--unique-proxy", action="store_true", help="Require 1 account 1 unique IP")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without launching browser")
    parser.add_argument("--retry-failed", action="store_true", help="Retry failed accounts")
    parser.add_argument("--proxy-timeout", type=float, default=6.0, help="Proxy precheck timeout in seconds")
    parser.add_argument("--skip-proxy-precheck", action="store_true", help="Skip pre-checking proxies")
    parser.add_argument("--screenshot-dir", default="screenshots-inferencedahl", help="Screenshot output folder")

    args = parser.parse_args()
    setup_process_signals()

    logger = create_logger("inferencedahl")

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
            logger.info(f"Loaded {len(proxies)} proxies for Inference Dahl (reuse={args.reuse_proxy})")
        else:
            logger.warn("No proxy file found, falling back to direct connection.")
            args.use_proxy = False

    proxy_pool = InferenceDahlProxyPool(proxies, reuse_proxy=args.reuse_proxy) if (args.use_proxy and proxies) else None

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=["apikey-inferencedahl.txt"],
        account_result_file="akun-result-inferencedahl.txt",
        account_failed_file="akun-failed-inferencedahl.txt",
    )

    count = args.limit if args.limit > 0 else (len(proxies) if proxies else 1)
    worker_count = max(1, min(args.workers, count))
    logger.info(f"Inference Dahl mode: target={count} account(s) with {worker_count} parallel worker(s)")

    if args.dry_run:
        logger.info("Dry-run validation complete. Exiting.")
        return

    processed = 0
    success_count = 0
    max_total_attempts = max(count * 4, len(proxies) * 2, 10) if proxies else count
    lock = asyncio.Lock()

    async def dahl_worker(worker_id: int):
        nonlocal processed, success_count
        while True:
            proxy = None
            async with lock:
                if success_count >= count or processed >= max_total_attempts:
                    break
                processed += 1
                attempt_num = processed

            if args.use_proxy and proxy_pool:
                proxy = await proxy_pool.get_next_live_proxy(
                    target_url=DEFAULT_LANDING_URL,
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

            session_id = f"dahl-w{worker_id}-{attempt_num}-{random.randint(1000, 9999)}"
            acc_logger = create_logger(f"w{worker_id}:{session_id}")
            logger.info(f"Worker #{worker_id} VPS status: {get_vps_system_status()}")

            ok = False
            try:
                ok = await asyncio.wait_for(
                    run_inferencedahl_single(
                        session_id=session_id,
                        proxy=proxy,
                        store=store,
                        results=results,
                        args=args,
                        logger=acc_logger,
                    ),
                    timeout=240.0,
                )
            except asyncio.TimeoutError:
                acc_logger.error(f"HARD TIMEOUT: Execution of {session_id} exceeded 240s.")
                store.upsert({"email": session_id, "status": FlowState.FAILED, "notes": "HARD_TIMEOUT_240S"})
                results.mark_failed(session_id, "HARD_TIMEOUT_240S")
                ok = False
            except TurnstileFailedException:
                ok = False
                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, False)
                    acc_logger.warn(f"🚫 Flagged proxy {proxy.server} permanently discarded from pool due to Turnstile failure.")
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

    workers = [asyncio.create_task(dahl_worker(i + 1)) for i in range(worker_count)]
    try:
        await asyncio.gather(*workers)
    finally:
        kill_descendant_processes()
        cleanup_leftover_browser_processes()
        cleanup_temp_profiles()

    logger.info(f"Inference Dahl finished. Succeeded: {success_count}/{count} (Total processed attempts: {processed})")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
