import asyncio
import random
import time
from typing import Optional
from playwright.async_api import Page
from .log import Logger

async def resolve_turnstile_if_present(
    page: Page,
    timeout_sec: int = 25,
    logger: Optional[Logger] = None
) -> bool:
    """
    Detects and automatically clicks the Cloudflare Turnstile CAPTCHA checkbox
    if it appears on the page (e.g. Clerk's 'Security check: Complete this verification').

    Uses a multi-tier strategy:
    1. Hardware coordinate mouse click on the Turnstile iframe checkbox (x: +30, y: center).
    2. Playwright element click with position offset.
    3. FrameLocator internal element click.
    """
    start_time = time.time()
    solved = False

    while time.time() - start_time < timeout_sec:
        if page.is_closed():
            return False

        # If already redirected to Google or next step, we are done
        curr_url = page.url
        if "accounts.google.com" in curr_url or "/sign-up/continue" in curr_url or "/welcome" in curr_url or "/keys" in curr_url:
            return True

        # Check for Turnstile iframe or "Security check" indicators
        # 1. Check iframes matching Cloudflare Turnstile
        turnstile_loc = page.locator(
            "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], iframe[title*='Cloudflare' i], iframe[title*='Turnstile' i]"
        )

        count = await turnstile_loc.count()
        if count > 0:
            if logger:
                logger.info("[turnstile] Cloudflare Turnstile challenge terdeteksi! Memulai auto-click...")

            # Wait briefly for the Turnstile widget to settle and finish rendering the checkbox
            await asyncio.sleep(1.2)

            for i in range(count):
                ifr = turnstile_loc.nth(i)
                try:
                    await ifr.scroll_into_view_if_needed(timeout=3000)
                except Exception:
                    pass

                box = await ifr.bounding_box()
                if not box or box["width"] < 40 or box["height"] < 20:
                    continue

                # The Turnstile checkbox is located at x: ~28-32px from left, y: centered vertically (~32px)
                click_offset_x = min(30, int(box["width"] * 0.15))
                click_offset_y = int(box["height"] / 2) if box["height"] > 0 else 32
                abs_x = box["x"] + click_offset_x
                abs_y = box["y"] + click_offset_y

                if logger:
                    logger.info(f"[turnstile] Widget koordinat: ({box['x']:.0f}, {box['y']:.0f}), ukuran: {box['width']:.0f}x{box['height']:.0f}")
                    logger.info(f"[turnstile] Mengklik checkbox Turnstile di koordinat ({abs_x:.1f}, {abs_y:.1f})...")

                # Strategy A: Real mouse movement with natural Bezier steps, hover, and press
                try:
                    await page.mouse.move(abs_x, abs_y, steps=random.randint(6, 12))
                    await asyncio.sleep(random.uniform(0.15, 0.3))
                    await page.mouse.down()
                    await asyncio.sleep(random.uniform(0.06, 0.12))
                    await page.mouse.up()
                    if logger:
                        logger.info("[turnstile] Mouse click terkirim ke Turnstile checkbox!")
                except Exception as e:
                    if logger:
                        logger.warn(f"[turnstile] Mouse coordinate click gagal: {e}")

                # Strategy B: Element click with position offset
                try:
                    await ifr.click(position={"x": click_offset_x, "y": click_offset_y}, timeout=3000)
                    if logger:
                        logger.info("[turnstile] Iframe position click terkirim!")
                except Exception:
                    pass

                # Strategy C: FrameLocator internal element click
                try:
                    frame_loc = page.frame_locator("iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']").nth(i)
                    for sel in [".ctp-checkbox-label", "input[type='checkbox']", "#challenge-stage", ".cb-lb", "span.mark"]:
                        target = frame_loc.locator(sel)
                        if await target.count() > 0:
                            await target.first.click(timeout=2000)
                            if logger:
                                logger.info(f"[turnstile] Frame element {sel} berhasil diklik!")
                            break
                except Exception:
                    pass

                # Wait 2.5s to see if Turnstile verifies and navigates
                for _ in range(5):
                    await asyncio.sleep(0.5)
                    url_now = page.url
                    if "accounts.google.com" in url_now or "/sign-up/continue" in url_now:
                        if logger:
                            logger.info(f"[turnstile] Verifikasi lolos! Halaman dialihkan ke: {url_now[:80]}...")
                        return True

                solved = True

        # Check if page has already moved on
        if "accounts.google.com" in page.url:
            return True

        await asyncio.sleep(0.8)

    return solved
