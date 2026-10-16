import asyncio
import re
from typing import Optional, List
from playwright.async_api import Page, BrowserContext
from .browser import human_delay, human_type
from .log import Logger

GOOGLE_AUTH_URL_RE = re.compile(r"accounts\.google\.com", re.I)
RESTRICTED_RE = re.compile(r"(account\s+has\s+been\s+disabled|account\s+restricted|aktivitas\s+mencurigakan|tidak\s+dapat\s+memverifikasi)", re.I)

class GooglePhoneVerificationException(RuntimeError):
    """Raised when Google presents a phone number verification challenge (SMS / call)."""
    pass

PHONE_VERIFICATION_RE = re.compile(
    r"(enter\s+a\s+phone\s+number|"
    r"masukkan\s+nomor\s+telepon|"
    r"standard\s+message\s+and\s+data\s+rates|"
    r"tarif\s+pesan\s+dan\s+data\s+standar|"
    r"phone\s+number\s+cannot\s+be\s+used\s+for\s+verification|"
    r"nomor\s+telepon\s+ini\s+tidak\s+dapat\s+digunakan|"
    r"phone\s+number\s+has\s+already\s+been\s+used|"
    r"get\s+a\s+text\s+message\s+with\s+a\s+verification\s+code|"
    r"dapatkan\s+sms\s+berisi\s+kode\s+verifikasi)",
    re.I
)

async def is_google_phone_verification(page: Page) -> bool:
    """
    Detects whether Google is presenting a phone verification challenge screen
    (requiring SMS / phone call verification code or entering a phone number).
    """
    try:
        url = (page.url or "").lower()
        if not GOOGLE_AUTH_URL_RE.search(url):
            return False

        # 1. Specific Google challenge URL endpoints for phone verification
        if any(ep in url for ep in ["/challenge/ipp", "/challenge/kpp"]):
            return True

        # 2. Check for explicit phone input selectors
        phone_input = await page.query_selector(
            'input[type="tel"], input#phoneNumberId, input[name="phoneNumber"], '
            'input[id="phoneNumberId"], input[autocomplete="tel"], input[autocomplete="tel-national"], '
            'div[data-challengetype="13"], div[data-challengetype="9"]'
        )
        if phone_input:
            try:
                if await phone_input.is_visible():
                    return True
            except Exception:
                return True

        # 3. Check page content for explicit phone challenge phrasing
        content = (await page.content() or "").lower()
        phone_needles = [
            "enter a phone number to get a text message",
            "enter a phone number",
            "masukkan nomor telepon untuk mendapatkan",
            "masukkan nomor telepon",
            "standard message and data rates may apply",
            "tarif pesan dan data standar",
            "google will store this number and only use it for security purposes",
            "google akan menyimpan nomor ini",
            "phone number cannot be used for verification",
            "nomor telepon ini tidak dapat digunakan untuk verifikasi",
            "this phone number has already been used too many times",
            "nomor telepon ini sudah digunakan terlalu sering",
            "get a verification code sent to your phone",
            "dapatkan kode verifikasi yang dikirimkan ke ponsel",
        ]
        if any(needle in content for needle in phone_needles):
            if "challenge" in url or "signin" in url or "identifier" in url or "v3/signin" in url:
                return True

        # 4. Check DOM evaluate for "Verify it's you" paired with phone cues
        is_phone_chal = await page.evaluate("""() => {
            const txt = (document.body ? document.body.innerText : '').toLowerCase();
            const hasPhoneText = txt.includes('phone number') || txt.includes('nomor telepon');
            const hasVerifyTitle = txt.includes("verify it's you") || txt.includes("verifikasi diri anda");
            const hasPhoneInput = Boolean(document.querySelector('input[type="tel"], input#phoneNumberId, input[name="phoneNumber"]'));
            return (hasVerifyTitle && hasPhoneText) || (hasPhoneInput && hasPhoneText);
        }""")
        if is_phone_chal:
            return True

    except Exception:
        pass
    return False

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

    # 2. Check for Account Restricted or Disabled / Phone Verification
    if await is_google_phone_verification(target_page):
        raise GooglePhoneVerificationException("GOOGLE_PHONE_VERIFICATION: Google meminta verifikasi nomor HP")

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
        if await is_google_phone_verification(target_page):
            raise GooglePhoneVerificationException("GOOGLE_PHONE_VERIFICATION: Google meminta verifikasi nomor HP setelah email")
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
        # 1. Identify all active (open) pages
        open_pages = [p for p in context.pages if not p.is_closed()]
        google_pages = [p for p in open_pages if GOOGLE_AUTH_URL_RE.search(p.url)]

        # If there are NO active pages remaining on accounts.google.com, verify whether OAuth has truly completed
        if not google_pages:
            # Check if any open page is in a transient state (about:blank or not http)
            transient = any(p.url == "about:blank" or not p.url.startswith("http") for p in open_pages)
            if transient:
                await asyncio.sleep(1)
                continue

            # Check if any open page has landed on an external non-Google relying party page
            non_google_pages = [
                p for p in open_pages
                if p.url.startswith("http") and not GOOGLE_AUTH_URL_RE.search(p.url)
            ]
            if non_google_pages:
                # Wait briefly to let any intermediate redirects settle (e.g. auth callbacks)
                await human_delay(1500, 2500)
                open_pages_check = [p for p in context.pages if not p.is_closed()]
                google_pages_check = [p for p in open_pages_check if GOOGLE_AUTH_URL_RE.search(p.url)]
                if not google_pages_check:
                    logger.info("No active Google authentication page remaining (OAuth redirect complete or popup closed).")
                    chosen = non_google_pages[0]
                    if not page.is_closed() and not GOOGLE_AUTH_URL_RE.search(page.url) and page.url.startswith("http"):
                        chosen = page
                    try:
                        await chosen.bring_to_front()
                    except Exception:
                        pass
                    return chosen
                # If Google page reappeared (redirected to another consent/approval step), stay in loop
                continue

            # Still settling
            await asyncio.sleep(1)
            continue

        # There is still an active Google page (popup or tab). Flow is still ongoing!
        target_page = google_pages[0]
        try:
            await target_page.bring_to_front()
        except Exception:
            pass

        current_url = target_page.url

        # Check for Google Phone Verification challenge FIRST before any button clicks
        if await is_google_phone_verification(target_page):
            logger.warn(f"detected Google phone verification challenge on {current_url}")
            raise GooglePhoneVerificationException("GOOGLE_PHONE_VERIFICATION: Google meminta verifikasi nomor HP")

        content = await target_page.content()
        content_lower = content.lower()
        if "wrong password" in content_lower or "sandi salah" in content_lower:
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

        # Check if password, email, or phone input is currently active on screen
        has_cred_input = await target_page.evaluate("""() => {
            const inputs = Array.from(document.querySelectorAll(
                'input[type="password"], input#identifierId, input[name="identifier"], input[type="tel"], #phoneNumberId'
            ));
            return inputs.some(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        }""")
        if has_cred_input:
            await asyncio.sleep(1)
            continue

        # Smart DOM evaluator for Google OAuth consent, speedbump, permissions, TOS, and confirmations
        clicked_info = None
        try:
            clicked_info = await target_page.evaluate("""() => {
                const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();

                // Never click Cancel / Close / Switch account / Back / Learn more
                const negativeNeedles = [
                    'cancel', 'batal', '取消', 'close', 'tutup', '关闭',
                    'learn more', 'pelajari lebih lanjut', '了解详情',
                    'switch account', 'ganti akun', '切换帐号',
                    'back', 'kembali', '返回', 'reject', 'tolak', '拒绝'
                ];

                // Priority 1: High-confidence consent / continue / approval needles
                const p1Needles = [
                    'continue', 'lanjutkan', '继续',
                    'allow', 'izinkan', '允许',
                    'confirm', 'konfirmasi', '确认',
                    'i understand', 'saya mengerti', '我了解', '我明白',
                    'i agree', 'saya setuju', '我同意',
                    'accept all', 'accept', 'terima', '同意'
                ];

                // Priority 2: Secondary advance needles
                const p2Needles = [
                    'next', 'berikutnya', '下一步',
                    'got it', 'mengerti', '知道了',
                    'done', 'selesai', '完成'
                ];

                const isVisible = (el) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 &&
                           style.display !== 'none' && style.visibility !== 'hidden' &&
                           !el.disabled && el.getAttribute('aria-disabled') !== 'true';
                };

                const candidates = Array.from(document.querySelectorAll(
                    'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
                )).filter(isVisible);

                let bestEl = null;
                let bestScore = -1;
                let bestText = '';

                for (const el of candidates) {
                    const txt = norm([
                        el.textContent,
                        el.value,
                        el.getAttribute('aria-label'),
                        el.getAttribute('title')
                    ].filter(Boolean).join(' '));

                    if (!txt) continue;

                    // Skip negative
                    if (negativeNeedles.some(n => txt === n || txt.startsWith(n + ' ') || txt.endsWith(' ' + n))) {
                        continue;
                    }

                    // Score Priority 1
                    for (const needle of p1Needles) {
                        if (txt === needle) {
                            if (bestScore < 100) { bestScore = 100; bestEl = el; bestText = txt; }
                        } else if (txt.includes(needle)) {
                            if (bestScore < 80) { bestScore = 80; bestEl = el; bestText = txt; }
                        }
                    }

                    // Score Priority 2
                    for (const needle of p2Needles) {
                        if (txt === needle) {
                            if (bestScore < 60) { bestScore = 60; bestEl = el; bestText = txt; }
                        } else if (txt.includes(needle)) {
                            if (bestScore < 40) { bestScore = 40; bestEl = el; bestText = txt; }
                        }
                    }
                }

                // Priority 3: Google primary action button (e.g. button[jsname="LgbsSe"]), but never cancel
                if (!bestEl) {
                    const primaryBtns = Array.from(document.querySelectorAll('button[jsname="LgbsSe"], [role="button"][jsname="LgbsSe"]')).filter(isVisible);
                    for (const btn of primaryBtns) {
                        const txt = norm(btn.textContent || btn.getAttribute('aria-label') || '');
                        if (!negativeNeedles.some(n => txt.includes(n))) {
                            bestEl = btn;
                            bestText = txt || 'LgbsSe';
                            break;
                        }
                    }
                }

                if (bestEl) {
                    bestEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                    bestEl.focus();
                    bestEl.click();
                    return bestText;
                }
                return null;
            }""")
            if clicked_info:
                logger.info(f"successfully clicked Google consent/speedbump button via DOM evaluate: '{clicked_info}'")
                await human_delay(2000, 3500)
                continue
        except Exception as e:
            logger.warn(f"consent DOM evaluate click exception: {e}")

        # Fallback Playwright locators for consent / speedbump buttons
        fallback_selectors = [
            'button:has-text("Continue"), [role="button"]:has-text("Continue")',
            'button:has-text("Lanjutkan"), [role="button"]:has-text("Lanjutkan")',
            'button:has-text("继续"), [role="button"]:has-text("继续")',
            'button:has-text("I understand"), [role="button"]:has-text("I understand")',
            'button:has-text("Saya mengerti"), [role="button"]:has-text("Saya mengerti")',
            'button:has-text("Confirm"), [role="button"]:has-text("Confirm")',
            'button:has-text("Konfirmasi"), [role="button"]:has-text("Konfirmasi")',
            'button:has-text("Allow"), [role="button"]:has-text("Allow")',
            'button:has-text("Izinkan"), [role="button"]:has-text("Izinkan")',
            '#submit_approve_access',
            '#confirm',
            'button:has-text("Next"), [role="button"]:has-text("Next")',
            'button:has-text("Berikutnya"), [role="button"]:has-text("Berikutnya")',
            'button:has-text("下一步"), [role="button"]:has-text("下一步")',
        ]
        speedbump_handled = False
        for sel in fallback_selectors:
            try:
                btns = await target_page.query_selector_all(sel)
                for btn in btns:
                    if await btn.is_visible() and await btn.is_enabled():
                        btn_text = (await btn.text_content() or "").strip()
                        if any(neg in btn_text.lower() for neg in ["cancel", "batal", "取消", "close", "tutup"]):
                            continue
                        logger.info(f"detected Google consent / speedbump fallback button ('{btn_text}'), clicking...")
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

        if speedbump_handled:
            continue

        await asyncio.sleep(1)

    # Return whatever valid active page remains
    open_pages = [p for p in context.pages if not p.is_closed()]
    if not page.is_closed():
        return page
    for p in open_pages:
        if not GOOGLE_AUTH_URL_RE.search(p.url) and p.url != "about:blank":
            return p
    return target_page
