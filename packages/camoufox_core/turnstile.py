import asyncio
import random
import re
import time
from typing import Optional, Dict, Any, Tuple
from urllib.parse import urlparse, parse_qs
import requests
from playwright.async_api import Page
from .log import Logger

BYCF_SOLVE_API = "https://bycf.snowping.cfd/api/solve"

KNOWN_SITEKEYS: Dict[str, str] = {
    "tokenharbor.ai": "0x4AAAAAADBuC8Knz1EJZx9-",
}

async def solve_turnstile_via_api(
    url: str,
    sitekey: str,
    timeout_sec: float = 25.0,
    logger: Optional[Logger] = None,
) -> Optional[str]:
    """
    Calls bycf.snowping.cfd/api/solve to solve a Cloudflare Turnstile challenge and get a clearance token.
    """
    if logger:
        logger.info(f"[turnstile-api] Requesting clearance token from {BYCF_SOLVE_API} (sitekey={sitekey})...")
    try:
        def _post():
            return requests.post(
                BYCF_SOLVE_API,
                json={"url": url, "siteKey": sitekey},
                timeout=timeout_sec,
                headers={"Content-Type": "application/json"},
            )
        loop = asyncio.get_running_loop()
        resp = await loop.run_in_executor(None, _post)
        if resp.status_code == 200:
            data = resp.json()
            token = data.get("result", {}).get("token")
            solve_time = data.get("result", {}).get("solveTime", "unknown")
            if token:
                if logger:
                    logger.info(f"[turnstile-api] Clearance token successfully received! (solveTime: {solve_time}, tokenLen: {len(token)})")
                return token
            else:
                if logger:
                    logger.warn(f"[turnstile-api] Response 200 but token missing: {data}")
        else:
            if logger:
                logger.warn(f"[turnstile-api] API returned HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        if logger:
            logger.warn(f"[turnstile-api] Failed to solve via API: {e}")
    return None

async def setup_turnstile_interceptor(page: Page) -> None:
    """
    Injects an init script before navigation to intercept window.turnstile.render
    callbacks so that clearance tokens can be dispatched directly into React's state.
    """
    await page.add_init_script("""
        window._turnstileCallbacks = window._turnstileCallbacks || [];
        let _t = undefined;
        Object.defineProperty(window, 'turnstile', {
            configurable: true,
            get() { return _t; },
            set(val) {
                _t = val;
                if (val && typeof val.render === 'function' && !val._hooked) {
                    const orig = val.render;
                    val.render = function(container, params) {
                        if (params && typeof params.callback === 'function') {
                            window._turnstileCallbacks.push(params.callback);
                        }
                        return orig.apply(this, arguments);
                    };
                    val._hooked = true;
                }
            }
        });
    """)

async def inject_turnstile_token(page: Page, token: str, logger: Optional[Logger] = None) -> bool:
    """
    Injects a Turnstile clearance token into the page:
    1. Triggers all intercepted window._turnstileCallbacks (updating React state).
    2. Populates or creates input[name='cf-turnstile-response'].
    """
    try:
        res = await page.evaluate("""(token) => {
            let called = 0;
            if (window._turnstileCallbacks && window._turnstileCallbacks.length > 0) {
                window._turnstileCallbacks.forEach(cb => {
                    try { cb(token); called++; } catch(e){}
                });
            }
            if (window.turnstile && window.turnstile._widgets) {
                for (const k in window.turnstile._widgets) {
                    const w = window.turnstile._widgets[k];
                    if (w && typeof w.callback === 'function') {
                        try { w.callback(token); called++; } catch(e){}
                    }
                }
            }
            let inps = document.querySelectorAll('input[name="cf-turnstile-response"]');
            if (inps.length === 0) {
                const forms = document.querySelectorAll('form');
                forms.forEach(f => {
                    const inp = document.createElement('input');
                    inp.type = 'hidden';
                    inp.name = 'cf-turnstile-response';
                    inp.value = token;
                    f.appendChild(inp);
                });
            } else {
                inps.forEach(i => {
                    i.value = token;
                    i.dispatchEvent(new Event('input', { bubbles: true }));
                    i.dispatchEvent(new Event('change', { bubbles: true }));
                });
            }
            return { called, inputCount: document.querySelectorAll('input[name="cf-turnstile-response"]').length };
        }""", token)
        if logger:
            logger.info(f"[turnstile] Token injected into page: {res}")
        return True
    except Exception as e:
        if logger:
            logger.warn(f"[turnstile] Failed to inject token: {e}")
        return False

async def find_turnstile_sitekey(page: Page) -> Optional[Tuple[str, str]]:
    """
    Extracts the Cloudflare Turnstile sitekey from the active page.
    Returns (sitekey, source_description) or None.
    """
    # 1. Check DOM attribute data-sitekey / data-site-key
    try:
        res = await page.evaluate("""() => {
            const el = document.querySelector('[data-sitekey], [data-site-key], .cf-turnstile');
            if (el) {
                const k = el.getAttribute('data-sitekey') || el.getAttribute('data-site-key');
                if (k) return { key: k, source: 'dom_attribute' };
            }
            const inp = document.querySelector('input[name="cf-turnstile-response"]');
            if (inp && inp.parentElement) {
                const k = inp.parentElement.getAttribute('data-sitekey');
                if (k) return { key: k, source: 'response_input_parent' };
            }
            const clerk = document.querySelector('#clerk-captcha, [data-cl-interactive="true"]');
            if (clerk) {
                const k = clerk.getAttribute('data-sitekey');
                if (k) return { key: k, source: 'clerk_captcha' };
            }
            return null;
        }""")
        if res and res.get("key"):
            return res["key"], res["source"]
    except Exception:
        pass

    # 2. Check iframes matching challenges.cloudflare.com
    try:
        for f in page.frames:
            url = f.url or ""
            if "challenges.cloudflare.com" in url or "turnstile" in url:
                m = re.search(r"(0x4[A-Za-z0-9_\-]{15,})", url)
                if m:
                    return m.group(1), f"frame_url({f.name or 'iframe'})"
                parsed = urlparse(url)
                qs = parse_qs(parsed.query)
                if "sitekey" in qs:
                    return qs["sitekey"][0], "frame_query_sitekey"
                if "k" in qs:
                    return qs["k"][0], "frame_query_k"
    except Exception:
        pass

    # 3. Check page scripts or HTML content for 0x4 pattern
    try:
        content = await page.content()
        m = re.search(r"(0x4[A-Za-z0-9_\-]{20,})", content)
        if m:
            return m.group(1), "page_content_regex"
    except Exception:
        pass

    # 4. Check known sitekeys by domain
    try:
        host = urlparse(page.url).netloc.lower()
        for domain, sk in KNOWN_SITEKEYS.items():
            if domain in host:
                return sk, f"known_sitekey({domain})"
    except Exception:
        pass

    return None

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
                # Ensure frame is scrolled into view first so coordinates match the viewport
                try:
                    el = await f.frame_element()
                    if el:
                        await el.scroll_into_view_if_needed(timeout=3000)
                        await asyncio.sleep(0.15)
                except Exception:
                    pass

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
                                    # Large container or label: checkbox is on the left (~34px in)
                                    click_x = b["x"] + 34
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
            try:
                await ifr.scroll_into_view_if_needed(timeout=3000)
                await asyncio.sleep(0.15)
            except Exception:
                pass
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
            try:
                await parent.scroll_into_view_if_needed(timeout=3000)
                await asyncio.sleep(0.15)
            except Exception:
                pass
            box = await parent.bounding_box()
            if box and box["height"] >= 30 and box["width"] >= 80:
                widget_w = min(360, box["width"])
                widget_left = box["x"] + (box["width"] - widget_w) / 2
                click_x = widget_left + 34
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

async def dismiss_turnstile_modal(page: Page, logger: Optional[Logger] = None) -> bool:
    """Closes Cloudflare Turnstile error/troubleshooting popup modal if present."""
    dismissed = False
    try:
        await page.keyboard.press("Escape")
    except Exception:
        pass

    try:
        for f in page.frames:
            try:
                res = await f.evaluate("""() => {
                    const closeBtns = document.querySelectorAll('button[aria-label*="close" i], button[aria-label*="關閉" i], [role="dialog"] button, button.close, svg[aria-label*="close" i]');
                    for (const b of closeBtns) {
                        b.click();
                        return true;
                    }
                    return false;
                }""")
                if res:
                    dismissed = True
            except Exception:
                pass
    except Exception:
        pass

    try:
        res = await page.evaluate("""() => {
            const closeBtns = document.querySelectorAll('button[aria-label*="close" i], button[aria-label*="關閉" i], [role="dialog"] button, button.close');
            for (const b of closeBtns) {
                b.click();
                return true;
            }
            return false;
        }""")
        if res:
            dismissed = True
    except Exception:
        pass

    if dismissed and logger:
        logger.info("[turnstile] Pop-up modal troubleshooting Cloudflare ditutup.")
    return dismissed

async def resolve_turnstile_if_present(
    page: Page,
    timeout_sec: int = 25,
    logger: Optional[Logger] = None,
    use_api: bool = False,
    allow_click: bool = True,
) -> bool:
    """
    Detects and clicks the Cloudflare Turnstile CAPTCHA checkbox if present.
    Safely targets only the checkbox square and avoids clicking help / troubleshooting links.
    """
    start_time = time.time()
    click_attempts = 0

    while time.time() - start_time < timeout_sec:
        if page.is_closed():
            return False

        # If already solved, return immediately
        if await is_turnstile_solved(page):
            return True

        # Dismiss any troubleshooting modal if it popped up
        await dismiss_turnstile_modal(page, logger)

        target = await find_turnstile_target(page)
        if target:
            click_x = target["x"]
            click_y = target["y"]
            source = target["source"]
            box = target["box"]

            sk_info = await find_turnstile_sitekey(page)
            if logger:
                sk_msg = f" | 🔑 Sitekey: {sk_info[0]} ({sk_info[1]})" if sk_info else ""
                logger.info(
                    f"[turnstile] Challenge terdeteksi via {source}! "
                    f"Posisi: ({box['x']:.0f}, {box['y']:.0f}), {box['width']:.0f}x{box['height']:.0f}. "
                    f"Target checkbox: ({click_x:.1f}, {click_y:.1f}){sk_msg}"
                )

            # ── 0. Optional Fast-track via API if explicitly enabled ──
            if use_api and sk_info:
                sitekey = sk_info[0]
                token = await solve_turnstile_via_api(page.url, sitekey, timeout_sec=15.0, logger=logger)
                if token:
                    await inject_turnstile_token(page, token, logger=logger)
                    await asyncio.sleep(1.2)
                    if await is_turnstile_solved(page):
                        if logger:
                            logger.info(f"[turnstile] Verifikasi sukses via API clearance token! URL: {page.url[:80]}...")
                        return True

            if not allow_click:
                await asyncio.sleep(0.8)
                continue

            # Wait briefly for widget to fully settle before clicking
            await asyncio.sleep(random.uniform(0.6, 1.2))

            # ── 1. Clean mouse click directly on checkbox square ──────
            try:
                await page.mouse.move(click_x, click_y, steps=random.randint(12, 20))
                await asyncio.sleep(random.uniform(0.15, 0.25))
                await page.mouse.down()
                await asyncio.sleep(random.uniform(0.08, 0.14))
                await page.mouse.up()
                click_attempts += 1
                if logger:
                    logger.info(f"[turnstile] Mouse click #{click_attempts} terkirim ke checkbox ({click_x:.1f}, {click_y:.1f})!")
            except Exception as e:
                if logger:
                    logger.warn(f"[turnstile] Mouse click gagal: {e}")

            # ── 2. Verification loop: wait up to 4s for token / redirect ───
            for _ in range(8):
                await asyncio.sleep(0.5)
                await dismiss_turnstile_modal(page, logger)
                if await is_turnstile_solved(page):
                    if logger:
                        logger.info(f"[turnstile] Verifikasi sukses! Challenge teratasi. URL: {page.url[:80]}...")
                    return True

            if logger:
                logger.info("[turnstile] Belum ada respon token, mengecek ulang...")

        await asyncio.sleep(0.6)

    await dismiss_turnstile_modal(page, logger)
    return await is_turnstile_solved(page)

