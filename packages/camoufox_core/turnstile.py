import asyncio
import random
import time
from typing import Optional, Dict, Any
from playwright.async_api import Page
from .log import Logger

async def find_turnstile_target(page: Page) -> Optional[Dict[str, Any]]:
    """
    Finds the absolute screen (x, y) coordinates of the Cloudflare Turnstile checkbox.
    Supports:
    1. Direct iframes (standard / open shadow DOM)
    2. #clerk-captcha container & [data-cl-interactive='true'] (Clerk closed shadow root)
    3. 'Security check' / 'Complete this verification' card elements
    4. input[name='cf-turnstile-response'] container
    5. page.frames matching challenges.cloudflare.com
    """
    # ── Source 1: Check page.frames (Most reliable, pierces closed shadow DOM) ──
    try:
        for f in page.frames:
            url = f.url or ""
            if "challenges.cloudflare.com" in url or "turnstile" in url:
                # 1a. Try to locate specific checkbox or label element inside frame
                for sel in [
                    "input[type='checkbox']",
                    "span.mark",
                    ".ctp-checkbox-label",
                    "#challenge-stage",
                    ".cb-lb",
                ]:
                    try:
                        loc = f.locator(sel).first
                        if await loc.count() > 0:
                            b = await loc.bounding_box()
                            if b and b["width"] > 0 and b["height"] > 0:
                                if b["width"] > 60:
                                    # Large container or label: checkbox is on the left (~32px in)
                                    click_x = b["x"] + 32
                                    click_y = b["y"] + (b["height"] / 2)
                                else:
                                    click_x = b["x"] + (b["width"] / 2)
                                    click_y = b["y"] + (b["height"] / 2)
                                return {"x": click_x, "y": click_y, "source": f"frame_locator({sel})", "box": b}
                    except Exception:
                        pass

                # 1b. Use frame_element bounding box
                try:
                    el = await f.frame_element()
                    box = await el.bounding_box()
                    if box and box["width"] >= 80 and box["height"] >= 20:
                        # In standard Turnstile widget (300px to 380px wide, ~65-80px high):
                        # The checkbox square is centered at ~34px from the left edge of the iframe
                        click_x = box["x"] + 34
                        click_y = box["y"] + (box["height"] / 2)
                        return {"x": click_x, "y": click_y, "source": "frame_element", "box": box}
                except Exception:
                    pass
    except Exception:
        pass

    # ── Source 2: Direct iframe locator on page ──────────────────────
    try:
        turnstile_loc = page.locator(
            "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], iframe[title*='Cloudflare' i], iframe[title*='Turnstile' i]"
        )
        count = await turnstile_loc.count()
        for i in range(count):
            ifr = turnstile_loc.nth(i)
            box = await ifr.bounding_box()
            if box and box["width"] >= 80 and box["height"] >= 20:
                click_x = box["x"] + 34
                click_y = box["y"] + (box["height"] / 2)
                return {"x": click_x, "y": click_y, "source": "iframe_locator", "box": box}
    except Exception:
        pass

    # ── Source 3: Clerk shadow DOM evaluation ────────────────────────
    try:
        box = await page.evaluate("""() => {
            const container = document.querySelector('#clerk-captcha, [data-cl-interactive="true"]');
            if (!container) return null;
            let ifr = container.querySelector('iframe');
            if (!ifr && container.shadowRoot) {
                ifr = container.shadowRoot.querySelector('iframe');
            }
            if (!ifr) {
                for (const child of container.querySelectorAll('*')) {
                    if (child.shadowRoot) {
                        ifr = child.shadowRoot.querySelector('iframe');
                        if (ifr) break;
                    }
                }
            }
            if (ifr) {
                const r = ifr.getBoundingClientRect();
                if (r.width >= 80 && r.height >= 20) {
                    return { x: r.left, y: r.top, width: r.width, height: r.height };
                }
            }
            return null;
        }""")
        if box:
            click_x = box["x"] + 34
            click_y = box["y"] + (box["height"] / 2)
            return {"x": click_x, "y": click_y, "source": "clerk_shadow_iframe", "box": box}
    except Exception:
        pass

    # ── Source 4: Clerk captcha container (#clerk-captcha) ───────────
    try:
        clerk_loc = page.locator("#clerk-captcha, [data-cl-interactive='true']")
        if await clerk_loc.count() > 0:
            el = clerk_loc.first
            box = await el.bounding_box()
            if box and box["height"] >= 30 and box["width"] >= 80:
                widget_w = min(360, box["width"])
                widget_left = box["x"] + (box["width"] - widget_w) / 2
                click_x = widget_left + 42
                click_y = box["y"] + (box["height"] / 2)
                return {"x": click_x, "y": click_y, "source": "clerk_captcha", "box": box}
    except Exception:
        pass

    # ── Source 5: "Security check" card or verification text ─────────
    try:
        sec_loc = page.locator("text=/Security check/i, text=/Complete this verification/i")
        if await sec_loc.count() > 0:
            card = sec_loc.first.locator("xpath=ancestor::div[contains(@class, 'bg-white') or contains(@class, 'rounded') or contains(@class, 'border')][1]")
            if await card.count() == 0:
                card = sec_loc.first.locator("xpath=..")
            box = await card.bounding_box()
            if box and box["height"] >= 60 and box["width"] >= 150:
                widget_w = min(360, box["width"] - 40)
                widget_left = box["x"] + (box["width"] - widget_w) / 2
                click_x = widget_left + 48
                click_y = box["y"] + box["height"] - 38
                return {"x": click_x, "y": click_y, "source": "security_card", "box": box}
    except Exception:
        pass

    # ── Source 6: Hidden response input parent container ─────────────
    try:
        resp_input = page.locator("input[name='cf-turnstile-response']")
        if await resp_input.count() > 0:
            parent = resp_input.first.locator("xpath=ancestor::div[contains(@id, 'captcha') or @data-cl-interactive='true'][1]")
            if await parent.count() == 0:
                parent = resp_input.first.locator("xpath=..")
            box = await parent.bounding_box()
            if box and box["height"] >= 30 and box["width"] >= 80:
                widget_w = min(360, box["width"])
                widget_left = box["x"] + (box["width"] - widget_w) / 2
                click_x = widget_left + 42
                click_y = box["y"] + (box["height"] / 2)
                return {"x": click_x, "y": click_y, "source": "response_input_parent", "box": box}
    except Exception:
        pass

    return None

async def is_turnstile_solved(page: Page) -> bool:
    """Checks if Turnstile challenge has been passed or token generated."""
    try:
        url = page.url or ""
        if "accounts.google.com" in url or "/sign-up/continue" in url or "/welcome" in url:
            return True
        val = await page.evaluate("""() => {
            const inp = document.querySelector('input[name="cf-turnstile-response"], [name="cf-turnstile-response"]');
            return inp ? inp.value : '';
        }""")
        return bool(val and len(val) > 10)
    except Exception:
        return False

async def resolve_turnstile_if_present(
    page: Page,
    timeout_sec: int = 25,
    logger: Optional[Logger] = None
) -> bool:
    """
    Detects and automatically clicks the Cloudflare Turnstile CAPTCHA checkbox
    if it appears on the page (e.g. Clerk's 'Security check: Complete this verification').

    Uses coordinate mouse navigation to click into the checkbox even through
    closed shadow DOM / cross-origin iframes.
    """
    start_time = time.time()
    click_attempts = 0

    while time.time() - start_time < timeout_sec:
        if page.is_closed():
            return False

        # If already redirected to Google or next step, we are done
        if await is_turnstile_solved(page):
            return True

        target = await find_turnstile_target(page)
        if target:
            click_x = target["x"]
            click_y = target["y"]
            source = target["source"]
            box = target["box"]

            if logger:
                logger.info(
                    f"[turnstile] Challenge terdeteksi via {source}! "
                    f"Posisi: ({box['x']:.0f}, {box['y']:.0f}), {box['width']:.0f}x{box['height']:.0f}. "
                    f"Target checkbox: ({click_x:.1f}, {click_y:.1f})"
                )

            # Wait briefly for widget to fully settle before clicking
            await asyncio.sleep(random.uniform(0.6, 1.2))

            # ── 1. Real human mouse movement to checkbox coordinates ──────
            try:
                await page.mouse.move(click_x, click_y, steps=random.randint(10, 20))
                await asyncio.sleep(random.uniform(0.12, 0.25))
                await page.mouse.down()
                await asyncio.sleep(random.uniform(0.06, 0.12))
                await page.mouse.up()
                click_attempts += 1
                if logger:
                    logger.info(f"[turnstile] Mouse click #{click_attempts} terkirim ke ({click_x:.1f}, {click_y:.1f})!")
            except Exception as e:
                if logger:
                    logger.warn(f"[turnstile] Mouse click gagal: {e}")

            # ── 2. Click with horizontal offsets into the active label area ─
            # In Cloudflare Turnstile, the entire label (.ctp-checkbox-label)
            # spanning both the checkbox square and the verification text is
            # interactive. Offsets ensure hitting the active target even with styling variations.
            for offset_x in [16, 32]:
                try:
                    await asyncio.sleep(0.18)
                    await page.mouse.click(click_x + offset_x, click_y)
                except Exception:
                    pass

            # ── 3. Internal frame evaluate click fallback ─────────────────
            try:
                for f in page.frames:
                    url = f.url or ""
                    if "challenges.cloudflare.com" in url or "turnstile" in url:
                        await f.evaluate("""() => {
                            const sel = 'input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, .cb-lb, span.mark';
                            const el = document.querySelector(sel);
                            if (el) el.click();
                        }""")
            except Exception:
                pass

            # ── 4. Verification loop: wait up to 4s for token / redirect ───
            for _ in range(8):
                await asyncio.sleep(0.5)
                if await is_turnstile_solved(page):
                    if logger:
                        logger.info(f"[turnstile] Verifikasi sukses! Challenge teratasi. URL: {page.url[:80]}...")
                    return True

            if logger:
                logger.info("[turnstile] Belum ada respon redirect/token, mencoba deteksi dan klik ulang...")

        await asyncio.sleep(0.6)

    return await is_turnstile_solved(page)
