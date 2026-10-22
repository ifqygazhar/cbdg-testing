#!/usr/bin/env python3
"""
TokenHarbor Gmail Auto-Verifier
Verifies TokenHarbor accounts stuck in `email_verification_required` state by:
1. Identifying unverified accounts/keys via live API probe.
2. Logging into Google Workspace / Gmail using Camoufox with automatic speedbump resolution.
3. Extracting the TokenHarbor verification link and navigating to it.
4. Verifying that the API key becomes LIVE (HTTP 200 OK) and saving to good files.
"""

from __future__ import annotations
import argparse
import asyncio
import html
import os
import re
import sys
import time
from typing import List, Tuple, Optional, Dict, Any, Set, Union
from urllib.parse import urlparse, parse_qs
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from packages.camoufox_core.browser import launch_camoufox, setup_process_signals
from packages.camoufox_core.google_oauth import perform_google_oauth
from packages.camoufox_core.turnstile import resolve_turnstile_if_present
from packages.camoufox_core.log import create_logger

logger = create_logger("tokenharbor_verify")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[a-zA-Z0-9_\-]+", re.I)


def verify_tokenharbor_key_api(api_key: str, timeout_sec: float = 20.0, max_retries: int = 2) -> Tuple[bool, int, str]:
    if not api_key:
        return False, 0, "no_key"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
    payload = {
        "model": "deepseek-v4-flash:free",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 5,
    }

    last_err = ""
    last_status = 0
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://tokenharbor.ai/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=timeout_sec,
            )
            if resp.status_code == 200:
                return True, 200, "ok"
            try:
                data = resp.json()
                err_msg = data.get("error", {}).get("message", f"HTTP_{resp.status_code}")
            except Exception:
                err_msg = f"HTTP_{resp.status_code}"

            if resp.status_code in (401, 403):
                return False, resp.status_code, err_msg

            last_status = resp.status_code
            last_err = err_msg
        except Exception as e:
            last_status = 0
            last_err = str(e)

        if attempt < max_retries - 1:
            time.sleep(2.0)

    return False, last_status, last_err


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

    is_verif_needed = ("verify your email" in msg.lower() or "confirmation link" in msg.lower() or "email_verification" in msg.lower())
    if status != 403 or not is_verif_needed:
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
        reload_counter = 0
        while time.time() - start_time < 90:
            if "speedbump" in page.url or "termsofservice" in page.url or "welcome" in page.url:
                await handle_speedbump_robust(page)
                await asyncio.sleep(2)

            # ── Step A: Check if email detail view is currently open ─────────
            is_detail_open = await page.evaluate("""() => {
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
                    btn_link = await page.query_selector('a:has-text("Verify email"), a[href*="tokenharbor.ai/verify-email"]')
                    if btn_link:
                        raw_href = await btn_link.get_attribute("href")
                        if raw_href:
                            raw_href = html.unescape(raw_href)
                            if "google.com/url" in raw_href:
                                parsed = urlparse(raw_href)
                                qs = parse_qs(parsed.query)
                                verify_url = qs.get("q", [raw_href])[0]
                            else:
                                verify_url = raw_href
                            if verify_url:
                                break
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
                    logger.info(f"Found verification link: {verify_url}")
                    break
                else:
                    logger.warn("Detail view open but verify link not yet ready, retrying...")
                    await asyncio.sleep(1.5)
                    continue

            # ── Step B: If in inbox list, locate email row and click to open ───
            email_row = await page.query_selector(
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
                await page.evaluate("""() => {
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
                    opened = await page.evaluate("""() => {
                        const hash = window.location.hash || '';
                        const hasThreadHash = hash.startsWith('#inbox/') && hash.length > 7;
                        const heading = document.querySelector('h2.hP');
                        const hasHeading = heading && (heading.textContent || '').includes('Verify your email');
                        const msgBody = document.querySelector('div.a3s');
                        return Boolean(hasThreadHash || hasHeading || msgBody);
                    }""")
                    if opened:
                        logger.info("Successfully entered Token Harbor email detail view in Gmail!")
                        break

                # Detail view will be processed on next iteration (Step A)
                continue

            # ── Step C: Refresh or reload inbox ──────────────────────────────
            reload_counter += 1
            try:
                refresh_btn = await page.query_selector('div[aria-label*="Refresh" i], div[data-tooltip*="Refresh" i], div[act="20"]')
                if refresh_btn and reload_counter % 3 != 0:
                    logger.info("Token Harbor email not visible yet; clicking refresh button...")
                    await refresh_btn.click()
                else:
                    logger.info("Token Harbor email not visible yet; reloading page...")
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
    parser.add_argument("--keys-file", default="", help="Path to API keys file")
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
    candidate_files = []
    if args.keys_file and os.path.exists(args.keys_file):
        candidate_files.append(args.keys_file)
    else:
        for f in ["apikey-need-verif-tokenharbor.txt", "akun-need-verif-tokenharbor.txt", "apikey-unli.txt", "akun-bad-tokenharbor.txt"]:
            if os.path.exists(f):
                candidate_files.append(f)

    unverified: List[Tuple[str, str, str]] = []
    for kf in candidate_files:
        with open(kf, "r", encoding="utf-8") as f:
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
                elif len(parts) == 1 and raw.startswith("thk_"):
                    # Plain key: try to match with accounts
                    pass

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
        is_verif_needed = ("verify your email" in msg.lower() or "confirmation link" in msg.lower() or "email_verification" in msg.lower())
        if not is_valid and status == 403 and is_verif_needed:
            ok = await verify_single_account(email, pwd, key, headed=args.headed)
            if ok:
                verified_count += 1
                # Append to good files
                with open("akun-good-tokenharbor.txt", "a", encoding="utf-8") as gf:
                    gf.write(f"{email}:{pwd}:{key}\n")
                with open("apikey-good-tokenharbor.txt", "a", encoding="utf-8") as kf:
                    kf.write(f"{key}\n")

                # Remove from need-verif files
                for vf in ["apikey-need-verif-tokenharbor.txt", "akun-need-verif-tokenharbor.txt"]:
                    if os.path.exists(vf):
                        try:
                            with open(vf, "r", encoding="utf-8") as rf:
                                remaining = [l for l in rf if email.lower() not in l.lower() and key not in l]
                            with open(vf, "w", encoding="utf-8") as wf:
                                wf.writelines(remaining)
                        except Exception:
                            pass

    logger.info(f"Verification completed: {verified_count} accounts verified.")


if __name__ == "__main__":
    asyncio.run(main())
