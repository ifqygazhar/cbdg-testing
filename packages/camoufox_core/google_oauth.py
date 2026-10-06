import asyncio
import re
from typing import Optional, List
from playwright.async_api import Page, BrowserContext
from .browser import human_delay, human_type
from .log import Logger

GOOGLE_AUTH_URL_RE = re.compile(r"accounts\.google\.com", re.I)
RESTRICTED_RE = re.compile(r"(account\s+has\s+been\s+disabled|account\s+restricted|aktivitas\s+mencurigakan|tidak\s+dapat\s+memverifikasi)", re.I)

async def find_google_page(context: BrowserContext, fallback_page: Page) -> Page:
    """Finds the page containing the Google sign in flow (same tab or popup)."""
    for page in context.pages:
        if GOOGLE_AUTH_URL_RE.search(page.url):
            return page
    return fallback_page

async def perform_google_oauth(
    page: Page,
    email: str,
    password: str,
    recovery_email: Optional[str] = None,
    timeout_sec: int = 90,
    logger: Optional[Logger] = None
) -> Page:
    """
    Automates Google OAuth login inside Camoufox / Playwright.
    Returns the page after redirect back to the application.
    """
    context = page.context
    logger = logger or Logger(email)

    # 1. Wait for Google Sign-in page
    logger.info("waiting for Google OAuth sign-in page...")
    target_page = page
    start_time = asyncio.get_event_loop().time()
    oauth_wait_timeout = max(45, min(timeout_sec, 90))

    while asyncio.get_event_loop().time() - start_time < oauth_wait_timeout:
        found = await find_google_page(context, page)
        if GOOGLE_AUTH_URL_RE.search(found.url):
            target_page = found
            break

        # Check if Turnstile popped up on the app page
        from .turnstile import resolve_turnstile_if_present
        solved = await resolve_turnstile_if_present(target_page, timeout_sec=2, logger=logger)
        if solved:
            await human_delay(1000, 2000)
            try:
                sso_btn = await target_page.query_selector('button[aria-label="Continue with Google"], button:has-text("Continue with Google")')
                if sso_btn:
                    await sso_btn.click(no_wait_after=True, timeout=5000)
            except Exception:
                pass

        await asyncio.sleep(0.5)


    if not GOOGLE_AUTH_URL_RE.search(target_page.url):
        logger.warn(f"current URL is {target_page.url}, attempting to proceed")

    # 2. Check for Account Restricted or Disabled
    page_text = await target_page.content()
    if RESTRICTED_RE.search(page_text):
        raise RuntimeError("ACCOUNT_RESTRICTED: Akun Google dibatasi / dinonaktifkan")

    # 3. Enter Email
    logger.info("entering Google email...")
    email_sel = "#identifierId"
    try:
        await target_page.wait_for_selector(email_sel, timeout=30000)
    except Exception:
        email_sel = 'input[type="email"], input[name="identifier"]'
        await target_page.wait_for_selector(email_sel, timeout=20000)

    await human_type(target_page, email_sel, email, timeout=30000)
    await human_delay(300, 700)

    # Click Next
    next_btn = await target_page.query_selector("#identifierNext button, #identifierNext")
    if next_btn:
        try:
            await next_btn.click(no_wait_after=True, timeout=15000)
        except Exception:
            await next_btn.click(force=True, no_wait_after=True, timeout=10000)
    else:
        await target_page.keyboard.press("Enter")

    await human_delay(1500, 2500)

    # 4. Wait for Password step
    logger.info("waiting for password step...")
    pwd_sel = 'input[type="password"], input[name="Passwd"], input[name="password"]'
    try:
        await target_page.wait_for_selector(pwd_sel, timeout=30000)
    except Exception as e:
        # Check if Google gave a security check or restriction
        content = await target_page.content()
        if RESTRICTED_RE.search(content):
            raise RuntimeError("ACCOUNT_RESTRICTED: Google membatasi akun setelah email")
        if "couldn't find your google account" in content.lower():
            raise RuntimeError("ACCOUNT_NOT_FOUND: Akun Google tidak ditemukan")
        raise RuntimeError(f"Gagal memuat password input: {e}")

    await human_type(target_page, pwd_sel, password, timeout=30000)
    await human_delay(400, 800)

    # Click Password Next
    pwd_next = await target_page.query_selector("#passwordNext button, #passwordNext")
    if pwd_next:
        try:
            await pwd_next.click(no_wait_after=True, timeout=15000)
        except Exception:
            await pwd_next.click(force=True, no_wait_after=True, timeout=10000)
    else:
        await target_page.keyboard.press("Enter")

    logger.info("password submitted, waiting for authentication response...")
    await human_delay(2000, 3500)

    # 5. Handle Challenge / Recovery Email / 2FA / Consent / Speedbump ("I understand")
    deadline = asyncio.get_event_loop().time() + timeout_sec
    while asyncio.get_event_loop().time() < deadline:
        # Keep track of active Google page (in case of tab/popup switch)
        for p in context.pages:
            if not p.is_closed() and GOOGLE_AUTH_URL_RE.search(p.url):
                target_page = p
                break

        current_url = target_page.url
        # Check if already redirected back from Google to the target application
        if not GOOGLE_AUTH_URL_RE.search(current_url) and current_url != "about:blank":
            logger.info(f"OAuth success, redirected to: {current_url}")
            return target_page

        # Check for another tab/page that might be the app page if popup closed
        for p in context.pages:
            if not p.is_closed() and not GOOGLE_AUTH_URL_RE.search(p.url) and p.url != "about:blank":
                logger.info(f"OAuth callback page active: {p.url}")
                return p

        content = await target_page.content()
        if "wrong password" in content.lower() or "sandi salah" in content.lower():
            raise RuntimeError("INVALID_PASSWORD: Sandi akun Google salah")

        if RESTRICTED_RE.search(content):
            raise RuntimeError("ACCOUNT_RESTRICTED: Google memblokir akses akun")

        # Check for recovery email challenge
        # Option 1: "Confirm your recovery email" selection
        recovery_choice = await target_page.query_selector('div[data-recovery-email-address], [data-challengetype="12"]')
        if recovery_choice:
            logger.info("detected recovery email option challenge, clicking...")
            try:
                await recovery_choice.click(no_wait_after=True, timeout=10000)
            except Exception:
                await recovery_choice.click(force=True, no_wait_after=True, timeout=5000)
            await human_delay(1000, 2000)

        # Option 2: recovery email input
        rec_input = await target_page.query_selector('input[name="knowledgePreregisteredEmailResponse"], input[id="knowledge-preregistered-email-response"]')
        if rec_input and recovery_email:
            logger.info(f"entering recovery email: {recovery_email}")
            await rec_input.fill(recovery_email)
            await human_delay(400, 800)
            rec_next = await target_page.query_selector('button:has-text("Next"), button:has-text("Berikutnya")')
            if rec_next:
                try:
                    await rec_next.click(no_wait_after=True, timeout=10000)
                except Exception:
                    await rec_next.click(force=True, no_wait_after=True, timeout=5000)
            else:
                await target_page.keyboard.press("Enter")
            await human_delay(2000, 3000)

        # Check if Account Chooser screen (click account matching email)
        acc_chooser = await target_page.query_selector(f'[data-identifier="{email}"]')
        if acc_chooser:
            logger.info(f"detected account chooser for {email}, clicking...")
            try:
                await acc_chooser.click(no_wait_after=True, timeout=10000)
            except Exception:
                await acc_chooser.click(force=True, no_wait_after=True, timeout=5000)
            await human_delay(1500, 2500)
            continue

        # Check for Google Speedbump / Workspace Terms of Service ("I understand", "Saya mengerti", "I agree", etc.)
        speedbump_handled = False
        speedbump_selectors = [
            'button:has-text("I understand")',
            'button:has-text("Saya mengerti")',
            'button:has-text("I agree")',
            'button:has-text("Saya setuju")',
            'button:has-text("Accept all")',
            'button:has-text("Accept")',
            'button:has-text("Terima")',
            'button:has-text("Continue")',
            'button:has-text("Lanjutkan")',
            'button:has-text("Confirm")',
            'button:has-text("Konfirmasi")',
            'button:has-text("Next")',
            'button:has-text("Berikutnya")',
            '#submit_approve_access',
            'button:has-text("Allow")',
            'button:has-text("Izinkan")',
            '#confirm',
            'button[jsname="LgbsSe"]',
        ]
        for sel in speedbump_selectors:
            try:
                btns = await target_page.query_selector_all(sel)
                for btn in btns:
                    if await btn.is_visible() and await btn.is_enabled():
                        btn_text = (await btn.text_content() or "").strip()
                        # Avoid clicking Next if we are still at email or password input step
                        if btn_text.lower() in ("next", "berikutnya") and (
                            await target_page.query_selector('input[type="password"]') or await target_page.query_selector('#identifierId')
                        ):
                            continue
                        logger.info(f"detected Google consent / speedbump button ('{btn_text}'), clicking...")
                        await btn.scroll_into_view_if_needed()
                        try:
                            await btn.click(no_wait_after=True, timeout=10000)
                        except Exception:
                            await btn.click(force=True, no_wait_after=True, timeout=5000)
                        await human_delay(2000, 3500)
                        speedbump_handled = True
                        break
                if speedbump_handled:
                    break
            except Exception:
                pass

        await asyncio.sleep(1)

    # Return whatever valid active page remains
    for p in context.pages:
        if not p.is_closed() and not GOOGLE_AUTH_URL_RE.search(p.url):
            return p
    return target_page
