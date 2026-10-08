#!/usr/bin/env python3
"""
TokenHarbor Gmail Auto-Verifier
Verifies TokenHarbor accounts stuck in `email_verification_required` state by:
1. Identifying unverified accounts/keys via live API probe.
2. Logging into Google Workspace / Gmail using Camoufox with automatic speedbump resolution.
3. Extracting the TokenHarbor verification link and navigating to it.
4. Verifying that the API key becomes LIVE (HTTP 200 OK) and saving to good files.
"""

import argparse
import asyncio
import html
import os
import re
import sys
import time
from typing import List, Tuple, Optional
from urllib.parse import urlparse, parse_qs
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from packages.camoufox_core.browser import launch_camoufox, setup_process_signals
from packages.camoufox_core.google_oauth import perform_google_oauth
from packages.camoufox_core.turnstile import resolve_turnstile_if_present
from packages.camoufox_core.log import create_logger

logger = create_logger("tokenharbor_verify")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[a-zA-Z0-9_\-]+", re.I)


def verify_tokenharbor_key_api(api_key: str, timeout_sec: float = 8.0) -> Tuple[bool, int, str]:
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
    except Exception as e:
        return False, 0, str(e)


async def handle_speedbump_robust(page) -> bool:
    try:
        clicked_text = await page.evaluate("""() => {
            const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const needles = [
                'i understand', 'saya mengerti', 'i agree', 'saya setuju',
                'accept all', 'accept', 'terima', 'continue', 'lanjutkan',
                'confirm', 'agree', 'entiendo', "j'ai compris", 'ich verstehe'
            ];
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
            logger.info(f"Clicked Google speedbump button: '{clicked_text}'")
            await asyncio.sleep(2.5)
            return True
    except Exception as e:
        logger.warn(f"Speedbump evaluate error: {e}")
    return False


async def verify_single_account(email: str, password: str, api_key: str, headed: bool = False) -> bool:
    logger.info(f"Checking account: {email}")
    is_valid, status, msg = verify_tokenharbor_key_api(api_key)
    if is_valid:
        logger.info(f"API key for {email} is ALREADY valid & live (HTTP 200 OK)!")
        return True

    if status != 403 or "email_verification_required" not in msg.lower():
        logger.warn(f"Account {email} reported HTTP {status} ({msg}) - not an email verification issue. Skipping.")
        return False

    logger.info(f"Account {email} needs email verification! Launching Camoufox...")
    browser_ctx = await launch_camoufox(headless=not headed, geoip=False)
    async with browser_ctx as browser:
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()
        page.set_default_timeout(60000)

        # Log into Google via ServiceLogin
        logger.info(f"Logging into Google for {email}...")
        await page.goto("https://accounts.google.com/ServiceLogin?service=mail", wait_until="domcontentloaded")
        await asyncio.sleep(2)

        page = await perform_google_oauth(
            page=page,
            email=email,
            password=password,
            timeout_sec=90,
            logger=logger,
        )
        await asyncio.sleep(2.5)

        # Handle Workspace speedbump if present
        if "speedbump" in page.url or "termsofservice" in page.url or "welcome" in page.url:
            await handle_speedbump_robust(page)
            await asyncio.sleep(2)

        # Go to Gmail inbox
        logger.info("Opening Gmail inbox...")
        await page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(4)

        verify_url = None
        start_time = time.time()
        while time.time() - start_time < 90:
            if "speedbump" in page.url or "termsofservice" in page.url or "welcome" in page.url:
                await handle_speedbump_robust(page)
                await asyncio.sleep(2)

            content = await page.content()
            m = VERIFY_LINK_RE.search(content)
            if m:
                raw_url = html.unescape(m.group(0))
                if "google.com/url" in raw_url:
                    parsed = urlparse(raw_url)
                    qs = parse_qs(parsed.query)
                    verify_url = qs.get("q", [raw_url])[0]
                else:
                    verify_url = raw_url
                logger.info(f"Found verification link: {verify_url}")
                break

            email_row = await page.query_selector(
                'tr.zA:has-text("Token Harbor"), tr:has-text("Token Harbor"), div[role="row"]:has-text("Token Harbor"), tr:has-text("Verify your email")'
            )
            if email_row:
                logger.info("Opening Token Harbor email in Gmail...")
                try:
                    await email_row.click()
                except Exception:
                    await email_row.click(force=True)
                await asyncio.sleep(3)
                content = await page.content()
                m = VERIFY_LINK_RE.search(content)
                if m:
                    raw_url = html.unescape(m.group(0))
                    if "google.com/url" in raw_url:
                        parsed = urlparse(raw_url)
                        qs = parse_qs(parsed.query)
                        verify_url = qs.get("q", [raw_url])[0]
                    else:
                        verify_url = raw_url
                    logger.info(f"Found verification link inside email: {verify_url}")
                    break

            try:
                refresh_btn = await page.query_selector('div[aria-label*="Refresh" i], div[data-tooltip*="Refresh" i], div[act="20"]')
                if refresh_btn:
                    await refresh_btn.click()
                else:
                    await page.reload(wait_until="domcontentloaded")
            except Exception:
                pass
            await asyncio.sleep(4)

        if not verify_url:
            logger.warn(f"Verification email not found in Gmail for {email}")
            return False

        # Visit the verification URL
        logger.info(f"Navigating to verification link: {verify_url}...")
        await page.goto(verify_url, wait_until="domcontentloaded")
        await asyncio.sleep(5)
        await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

        # Validate that the API key is now active
        post_valid, post_status, post_msg = verify_tokenharbor_key_api(api_key)
        if post_valid:
            logger.info(f"SUCCESS: {email} API key ({api_key[:12]}...) is now LIVE (HTTP 200 OK)!")
            return True
        else:
            logger.warn(f"Verification visited but API returned HTTP {post_status} ({post_msg})")
            return False


async def main():
    setup_process_signals()
    parser = argparse.ArgumentParser(description="TokenHarbor Gmail Auto-Verifier")
    parser.add_argument("--accounts-file", default="gsuite.txt", help="Path to accounts file")
    parser.add_argument("--keys-file", default="apikey-unli.txt", help="Path to API keys file")
    parser.add_argument("--headed", action="store_true", help="Run in headed mode")
    args = parser.parse_args()

    # Load accounts
    if not os.path.exists(args.accounts_file):
        logger.error(f"Accounts file {args.accounts_file} not found")
        sys.exit(1)

    accounts = {}
    with open(args.accounts_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(":")
            if len(parts) >= 2:
                accounts[parts[0].strip().lower()] = (parts[0].strip(), parts[1].strip())

    # Map keys to accounts
    # Format 1: In apikey-unli.txt, key might be plain key or email:pass:key
    unverified: List[Tuple[str, str, str]] = []
    if os.path.exists(args.keys_file):
        with open(args.keys_file, "r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                parts = raw.split(":")
                if len(parts) >= 3:
                    email = parts[0].strip()
                    pwd = parts[1].strip()
                    key = parts[-1].strip()
                    if key.startswith("thk_"):
                        unverified.append((email, pwd, key))
                elif raw.startswith("thk_"):
                    # Plain key: try to match with accounts
                    pass

    # Also check akun-bad-tokenharbor.txt
    if os.path.exists("akun-bad-tokenharbor.txt"):
        with open("akun-bad-tokenharbor.txt", "r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                parts = raw.split(":")
                if len(parts) >= 3:
                    email = parts[0].strip()
                    pwd = parts[1].strip()
                    key = parts[-1].strip()
                    if key.startswith("thk_") and email.lower() in accounts:
                        unverified.append((email, pwd, key))

    # De-duplicate
    seen = set()
    unique_unverified = []
    for em, pw, k in unverified:
        if (em.lower(), k) not in seen:
            seen.add((em.lower(), k))
            unique_unverified.append((em, pw, k))

    logger.info(f"Checking {len(unique_unverified)} accounts for verification status...")
    verified_count = 0
    for email, pwd, key in unique_unverified:
        is_valid, status, msg = verify_tokenharbor_key_api(key)
        if not is_valid and status == 403 and "email_verification_required" in msg.lower():
            ok = await verify_single_account(email, pwd, key, headed=args.headed)
            if ok:
                verified_count += 1
                # Append to good files
                with open("akun-good-tokenharbor.txt", "a", encoding="utf-8") as gf:
                    gf.write(f"{email}:{pwd}:{key}\n")
                with open("apikey-good-tokenharbor.txt", "a", encoding="utf-8") as kf:
                    kf.write(f"{key}\n")

    logger.info(f"Verification completed: {verified_count} accounts verified.")


if __name__ == "__main__":
    asyncio.run(main())
