#!/usr/bin/env python3
"""
Crusoe Cloud Camoufox Runner (Python + Camoufox / Firefox engine)
Bypasses Cloudflare / Bot detection and automates Crusoe signup + $5 API key extraction.
"""

import argparse
import asyncio
import os
import random
import re
import sys
import time
from typing import Optional

# Ensure repo root is on sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from packages.camoufox_core import (
    launch_camoufox,
    human_delay,
    human_type,
    perform_google_oauth,
    load_accounts,
    load_proxies,
    Account,
    Proxy,
    JsonlStore,
    ResultWriter,
    FlowState,
    create_logger,
)

CREDITS_RE = re.compile(r"credits?:?\s*\$5|\$5\.00|5\.00", re.I)
API_KEY_RE = re.compile(r"^[A-Za-z0-9_\-./+=]{20,}$")

async def run_single_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    screenshot_dir: str,
    logger,
) -> bool:
    email = account.email
    logger.info(f"starting Crusoe signup for {email} (proxy={proxy.server if proxy else 'direct'})")
    store.upsert({"email": email, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)

    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            page = await browser.new_page()
            page.set_default_timeout(35000)

            # ── 1. Navigate to Crusoe Request Foundry ────────────────────────
            logger.info("navigating to https://console.crusoecloud.com/request-foundry")
            await page.goto("https://console.crusoecloud.com/request-foundry", wait_until="domcontentloaded")
            await human_delay(1500, 2500)

            # ── 2. Click Sign up with Google ────────────────────────────────
            google_btn = await page.wait_for_selector(
                'button[aria-label*="Google" i], button:has-text("Sign up with Google")',
                timeout=20000,
            )
            if not google_btn:
                raise RuntimeError("Google signup button not found on Crusoe landing")

            logger.info("clicking Sign up with Google...")
            await google_btn.click()
            await human_delay(2000, 3000)

            # ── 3. Google OAuth Flow ────────────────────────────────────────
            post_auth_page = await perform_google_oauth(
                page=page,
                email=account.email,
                password=account.password,
                recovery_email=account.recovery_email,
                timeout_sec=60,
                logger=logger,
            )
            page = post_auth_page
            await human_delay(2000, 4000)

            # ── 4. Complete Signup / Accept Invitation if present ──────────
            name_input = await page.query_selector('input[aria-label="Name"], input#name')
            if name_input:
                logger.info("filling complete signup details (Name & Company)...")
                user_part = email.split("@")[0].capitalize()
                await human_type(page, 'input[aria-label="Name"], input#name', user_part)
                await human_delay(300, 600)

                company_input = await page.query_selector('input[aria-label="Company Name"], input#company')
                if company_input:
                    await human_type(page, 'input[aria-label="Company Name"], input#company', f"{user_part} Tech")
                    await human_delay(300, 600)

                # Check consent checkbox
                checkbox = await page.query_selector("input.ps-contract-target, input[type='checkbox']")
                if checkbox:
                    try:
                        await checkbox.check()
                    except Exception:
                        await page.evaluate("el => el.checked = true", checkbox)
                    await human_delay(400, 800)

                submit_btn = await page.query_selector('button:has-text("Create account"), button:has-text("Accept"), button[type="submit"]')
                if submit_btn:
                    logger.info("submitting complete signup...")
                    await submit_btn.click()
                    await human_delay(3000, 5000)

            # ── 5. Foundry Dashboard / Get API Key ──────────────────────────
            logger.info("waiting for Crusoe dashboard and 'Get API Key' button...")
            get_key_btn = await page.wait_for_selector(
                'button[aria-label="Get API Key"], button:has-text("Get API Key"), button:has-text("Create API Key")',
                timeout=30000,
            )
            if not get_key_btn:
                # Check if credit visible
                content = await page.content()
                if CREDITS_RE.search(content):
                    logger.info("bonus credit $5.00 verified on page!")
                raise RuntimeError("Get API Key button not found on dashboard")

            logger.info("clicking 'Get API Key' button to open flyout modal...")
            await get_key_btn.click()
            await human_delay(1500, 2500)

            # ── 6. In Flyout Modal: Alias & Create ───────────────────────────
            alias_input = await page.wait_for_selector("input#alias, input[aria-label*='Key Name' i], input[placeholder*='name' i]", timeout=15000)
            if alias_input:
                await human_type(page, "input#alias", "Default Key")
                await human_delay(400, 800)

            create_btn = await page.wait_for_selector('button[aria-label="Create"], button:has-text("Create")', timeout=10000)
            if create_btn:
                logger.info("clicking Create key button...")
                await create_btn.click()
                await human_delay(2000, 3500)

            # ── 7. Extract API Key ──────────────────────────────────────────
            logger.info("extracting generated Crusoe API Key...")
            api_key: Optional[str] = None
            deadline = time.time() + 25

            while time.time() < deadline:
                # Selector specific to Crusoe
                code_el = await page.query_selector('code[data-sentry-element="ApiKeyValue"], code')
                if code_el:
                    txt = (await code_el.text_content() or "").strip()
                    if API_KEY_RE.match(txt) and len(txt) >= 20 and " " not in txt:
                        api_key = txt
                        break
                await asyncio.sleep(1)

            if not api_key:
                ss_path = os.path.join(screenshot_dir, f"crusoe_no_key_{sanitized_email}.png")
                await page.screenshot(path=ss_path)
                raise RuntimeError(f"Crusoe API key not found (saved screenshot {ss_path})")

            logger.info(f"SUCCESS: Crusoe API Key obtained: {api_key[:10]}...{api_key[-6:]}")
            results.mark_success(email, account.password, api_key, extra="credits=$5.00")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "proxy": proxy.server if proxy else None})
            return True

    except Exception as e:
        err_msg = str(e)
        logger.error(f"FAILED for {email}: {err_msg}")
        results.mark_failed(email, account.password, err_msg)
        store.upsert({"email": email, "status": FlowState.FAILED, "error": err_msg, "proxy": proxy.server if proxy else None})
        return False

async def main_async():
    parser = argparse.ArgumentParser(description="Crusoe Cloud Camoufox Signup Automation")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser window")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--accounts-file", default="gsuite.txt", help="Path to gsuite accounts file")
    parser.add_argument("--proxy-file", default="", help="Path to proxies file")
    parser.add_argument("--output-file", default="apikey.txt", help="Path to save API keys")
    parser.add_argument("--state-file", default="state-crusoe.jsonl", help="State jsonl path")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of accounts to process")
    parser.add_argument("--delay", type=int, default=5, help="Delay in seconds between accounts")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate accounts and proxies without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-crusoe", help="Directory for screenshots")

    args = parser.parse_args()

    accounts = load_accounts(args.accounts_file)
    proxy_file = args.proxy_file
    if not proxy_file and not args.no_proxy:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    proxies = load_proxies(proxy_file) if (proxy_file and not args.no_proxy) else []
    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=[args.output_file],
        account_result_file="akun-result-crusoe.txt",
        account_failed_file="akun-failed-crusoe.txt",
    )

    logger = create_logger()
    logger.info(f"Loaded {len(accounts)} accounts, {len(proxies)} proxies for Crusoe")

    if args.dry_run:
        logger.info("dry-run: config validated, seeds parsed (no browser launched)")
        return


    processed = 0
    success_count = 0

    for i, account in enumerate(accounts):
        if args.limit > 0 and processed >= args.limit:
            break

        if store.is_done(account.email):
            logger.info(f"Skipping already DONE account: {account.email}")
            continue

        if store.is_restricted_or_banned(account.email) and not args.retry_failed:
            logger.warn(f"Skipping permanently restricted account: {account.email}")
            continue

        if not args.retry_failed and store.get(account.email) and store.get(account.email).get("status") == FlowState.FAILED:
            logger.info(f"Skipping previously failed account: {account.email}")
            continue

        proxy = proxies[i % len(proxies)] if proxies else None
        acc_logger = create_logger(account.email)

        ok = await run_single_account(
            account=account,
            proxy=proxy,
            store=store,
            results=results,
            headed=args.headed,
            screenshot_dir=args.screenshot_dir,
            logger=acc_logger,
        )

        processed += 1
        if ok:
            success_count += 1

        if i < len(accounts) - 1 and args.delay > 0:
            logger.info(f"Waiting {args.delay}s before next account...")
            await asyncio.sleep(args.delay)

    logger.info(f"Crusoe Camoufox batch finished: {success_count}/{processed} succeeded.")

def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
        sys.exit(130)

if __name__ == "__main__":
    main()
