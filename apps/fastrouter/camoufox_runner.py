#!/usr/bin/env python3
"""
FastRouter Camoufox Runner (Python + Camoufox / Firefox engine)
Bypasses Cloudflare Turnstile automatically and signs up via Google OAuth.
"""

import argparse
import asyncio
import os
import random
import re
import sys
import time
from typing import Optional, List

# Ensure repo root is on sys.path so packages.camoufox_core can be imported
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

API_KEY_RE = re.compile(r"sk-v1-[A-Za-z0-9_-]{20,}")
CREDITS_RE = re.compile(r"(available\s+credits:?\s*\$?1(\.00)?)|(\$1\.00)|(1\.00\s*credits?)", re.I)

COMPANY_NOUNS = [
    "Aether", "Apex", "Atlas", "Aurora", "Axon", "Chronos", "Cobalt", "Cortex",
    "Cyber", "Echo", "Flux", "Forge", "Helix", "Infini", "Kepler", "Krypton",
    "Lumen", "Matrix", "Meridian", "Nebula", "Nexus", "Nimbus", "Nova", "Omni",
    "Optima", "Orion", "Pharos", "Polaris", "Pulse", "Quantum", "Radix", "Shift",
    "Solaris", "Solstice", "Spectra", "Stratum", "Summit", "Synapse", "Tensor",
    "Titan", "Vanguard", "Vector", "Vertex", "Vortex", "Zenith", "Zephyr",
]
COMPANY_SUFFIXES = [
    "AI", "Labs", "Tech", "Cloud", "Systems", "Data", "Works", "Soft", "Digital",
    "Studio", "Solutions", "Dynamics", "Intelligence", "Compute", "Networks",
]

def generate_org_name(email: str) -> str:
    user = email.split("@")[0]
    clean_user = re.sub(r"[^a-zA-Z0-9]", "", user)
    if clean_user and random.random() < 0.4:
        return f"{clean_user.capitalize()} {random.choice(COMPANY_SUFFIXES)}"
    return f"{random.choice(COMPANY_NOUNS)} {random.choice(COMPANY_SUFFIXES)}"

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
    logger.info(f"starting FastRouter signup for {email} (proxy={proxy.server if proxy else 'direct'})")
    store.upsert({"email": email, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)

    browser_ctx = None
    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            page = await browser.new_page()
            page.set_default_timeout(30000)

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info("navigating to https://fastrouter.ai/sign-up")
            await page.goto("https://fastrouter.ai/sign-up", wait_until="domcontentloaded")
            await human_delay(1500, 2500)

            # ── 2. Click Google Sign Up ────────────────────────────────────
            google_btn = await page.wait_for_selector(
                'button[data-testid="oauth-signup-google"], button:has-text("Sign up with Google"), button[aria-label*="Google" i]',
                timeout=20000,
            )
            if not google_btn:
                raise RuntimeError("Google signup button not found")

            logger.info("clicking Sign up with Google (bypassing Turnstile via Camoufox)...")
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

            # ── 4. Complete Legal Terms if prompted (/sign-up/continue) ────
            if "/sign-up/continue" in page.url or await page.query_selector("input#legal_accepted"):
                logger.info("handling legal terms checkbox...")
                checkbox = await page.wait_for_selector("input#legal_accepted", timeout=15000)
                if checkbox:
                    # Some checkboxes are custom styled, force click or evaluate
                    try:
                        await checkbox.check()
                    except Exception:
                        await page.evaluate("el => el.checked = true", checkbox)
                    await human_delay(500, 1000)

                submit_btn = await page.wait_for_selector('button[type="submit"]', timeout=10000)
                if submit_btn:
                    logger.info("submitting legal terms...")
                    await submit_btn.click()
                    await human_delay(2000, 4000)

            # ── 5. Welcome Onboarding (/welcome) ───────────────────────────
            # Wait for welcome form or dashboard
            start_check = time.time()
            while time.time() - start_check < 25:
                curr_url = page.url
                if "/welcome" in curr_url or await page.query_selector("input#orgName"):
                    break
                if "/keys" in curr_url or "dashboard.fastrouter.ai" in curr_url:
                    break
                await asyncio.sleep(1)

            if "/welcome" in page.url or await page.query_selector("input#orgName"):
                logger.info("handling welcome onboarding form...")
                org_input = await page.wait_for_selector("input#orgName", timeout=15000)
                if org_input:
                    org_name = generate_org_name(email)
                    logger.info(f"filling organization name: {org_name}")
                    await human_type(page, "input#orgName", org_name)
                    await human_delay(400, 800)

                spend_input = await page.query_selector("input#monthlySpend")
                if spend_input:
                    spend_val = str(random.randint(1000, 10000))
                    logger.info(f"filling monthly spend: ${spend_val}")
                    await human_type(page, "input#monthlySpend", spend_val)
                    await human_delay(400, 800)

                # Optional checklist item
                labels = await page.query_selector_all("label.cursor-pointer")
                if len(labels) > 2:
                    try:
                        await labels[random.randint(2, len(labels) - 1)].click()
                        await human_delay(300, 600)
                    except Exception:
                        pass

                # Submit welcome form
                welcome_btn = await page.wait_for_selector('button[type="submit"]', timeout=10000)
                if welcome_btn:
                    logger.info("submitting welcome onboarding...")
                    await welcome_btn.click()
                    await human_delay(3000, 5000)

            # ── 6. Navigate to Keys / Dashboard ────────────────────────────
            # Ensure on keys page
            logger.info("navigating to FastRouter keys page...")
            if "/keys" not in page.url:
                try:
                    await page.goto("https://dashboard.fastrouter.ai/keys", wait_until="domcontentloaded", timeout=25000)
                except Exception:
                    # Try clicking keys sidebar
                    keys_link = await page.query_selector('a[href*="/keys"]')
                    if keys_link:
                        await keys_link.click()
            await human_delay(2000, 3500)

            # Check for $1.00 credit
            content = await page.content()
            if CREDITS_RE.search(content):
                logger.info("bonus credit $1.00 verified on dashboard!")
            else:
                logger.warn("credit $1.00 banner not explicitly found, proceeding to create key...")

            # Click "Create User Key" button
            create_key_btn = await page.wait_for_selector(
                'button:has-text("Create User Key"), button:has-text("Create Key"), button[data-slot="button"]:has-text("Create")',
                timeout=20000,
            )
            if not create_key_btn:
                # Try finding any button containing create
                buttons = await page.query_selector_all("button")
                for b in buttons:
                    txt = (await b.text_content() or "").strip()
                    if "create" in txt.lower() and "key" in txt.lower():
                        create_key_btn = b
                        break

            if not create_key_btn:
                raise RuntimeError("Button 'Create User Key' not found on /keys")

            logger.info("clicking 'Create User Key' button...")
            await create_key_btn.click()
            await human_delay(1500, 2500)

            # In modal: Key Name input (if present)
            name_input = await page.query_selector('input#api_key_name, input[placeholder*="Key Name" i], input[placeholder*="Name" i]')
            if name_input:
                await name_input.fill("Default Key")
                await human_delay(300, 600)
                # Click Save/Create
                save_btn = await page.query_selector('button:has-text("Save"), button:has-text("Create"), button[type="submit"]')
                if save_btn:
                    await save_btn.click()
                    await human_delay(1500, 2500)

            # ── 7. Extract API Key (sk-v1-...) ──────────────────────────────
            logger.info("extracting generated FastRouter API Key...")
            api_key: Optional[str] = None
            deadline = time.time() + 30

            while time.time() < deadline:
                modal_content = await page.content()
                matches = API_KEY_RE.findall(modal_content)
                # Filter out masked keys with ellipsis
                valid_matches = [m for m in matches if "..." not in m and len(m) >= 30]
                if valid_matches:
                    api_key = valid_matches[0]
                    break

                # Also inspect code elements specifically
                code_elements = await page.query_selector_all("code, input[readonly], span[class*='mono']")
                for el in code_elements:
                    val = (await el.text_content() or "") + (await el.get_attribute("value") or "")
                    m = API_KEY_RE.search(val)
                    if m and "..." not in m.group(0):
                        api_key = m.group(0)
                        break
                if api_key:
                    break
                await asyncio.sleep(1)

            if not api_key:
                # Capture screenshot for troubleshooting
                ss_path = os.path.join(screenshot_dir, f"no_key_{sanitized_email}.png")
                await page.screenshot(path=ss_path)
                raise RuntimeError(f"API key not found on page (saved screenshot {ss_path})")

            logger.info(f"SUCCESS: FastRouter API Key obtained: {api_key[:12]}...{api_key[-6:]}")
            results.mark_success(email, account.password, api_key, extra="credits=$1.00")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "proxy": proxy.server if proxy else None})
            return True

    except Exception as e:
        err_msg = str(e)
        logger.error(f"FAILED for {email}: {err_msg}")
        results.mark_failed(email, account.password, err_msg)
        store.upsert({"email": email, "status": FlowState.FAILED, "error": err_msg, "proxy": proxy.server if proxy else None})
        return False

async def main_async():
    parser = argparse.ArgumentParser(description="FastRouter Camoufox Signup Automation")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser window")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--accounts-file", default="", help="Path to gsuite accounts file")
    parser.add_argument("--proxy-file", default="", help="Path to proxies file")
    parser.add_argument("--output-file", default="", help="Path to save API keys")
    parser.add_argument("--state-file", default="state-fastrouter.jsonl", help="State jsonl path")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of accounts to process")
    parser.add_argument("--delay", type=int, default=5, help="Delay in seconds between accounts")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate accounts and proxies without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-fastrouter", help="Directory for screenshots")

    args = parser.parse_args()

    # Resolve accounts file
    accounts_file = args.accounts_file
    if not accounts_file:
        if os.path.exists("fastrouter_ai_dataset/gsuite.txt"):
            accounts_file = "fastrouter_ai_dataset/gsuite.txt"
        elif os.path.exists("gsuite.txt"):
            accounts_file = "gsuite.txt"
        else:
            print("Error: No accounts file found (checked fastrouter_ai_dataset/gsuite.txt and gsuite.txt)", file=sys.stderr)
            sys.exit(1)

    # Resolve proxies file
    proxy_file = args.proxy_file
    if not proxy_file and not args.no_proxy:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    # Resolve output files
    key_files = ["apikey-fastrouter.txt"]
    if os.path.exists("fastrouter_ai_dataset"):
        key_files.append("fastrouter_ai_dataset/apikey-fastrouter.txt")
    if args.output_file and args.output_file not in key_files:
        key_files.append(args.output_file)

    accounts = load_accounts(accounts_file)
    proxies = load_proxies(proxy_file) if (proxy_file and not args.no_proxy) else []

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file="akun-result-fastrouter.txt",
        account_failed_file="akun-failed-fastrouter.txt",
    )

    logger = create_logger()
    logger.info(f"Loaded {len(accounts)} accounts, {len(proxies)} proxies (proxy_mode={'no-proxy' if args.no_proxy or not proxies else 'active'})")

    if args.dry_run:
        logger.info("dry-run: config validated, seeds parsed (no browser launched)")
        return


    processed = 0
    success_count = 0

    for i, account in enumerate(accounts):
        if args.limit > 0 and processed >= args.limit:
            logger.info(f"Reached processing limit of {args.limit} accounts")
            break

        # Check existing state
        if store.is_done(account.email):
            logger.info(f"Skipping already DONE account: {account.email}")
            continue

        if store.is_restricted_or_banned(account.email) and not args.retry_failed:
            logger.warn(f"Skipping permanently restricted account: {account.email}")
            continue

        if not args.retry_failed and store.get(account.email) and store.get(account.email).get("status") == FlowState.FAILED:
            logger.info(f"Skipping previously failed account: {account.email}")
            continue

        # Assign proxy (unique per account if available, or direct)
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

    logger.info(f"FastRouter Camoufox batch finished: {success_count}/{processed} succeeded.")

def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
        sys.exit(130)

if __name__ == "__main__":
    main()
