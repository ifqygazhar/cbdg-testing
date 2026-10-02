import asyncio
import random
from typing import Optional, Dict, Any
from camoufox.async_api import AsyncCamoufox
from playwright.async_api import Browser, Page
from .loaders import Proxy

async def launch_camoufox(
    headless: bool = True,
    proxy: Optional[Proxy] = None,
    geoip: bool = True,
    **kwargs
) -> AsyncCamoufox:
    launch_kwargs: Dict[str, Any] = {
        "headless": headless,
        **kwargs
    }

    if proxy:
        proxy_dict: Dict[str, str] = {"server": proxy.server}
        if proxy.username:
            proxy_dict["username"] = proxy.username
        if proxy.password:
            proxy_dict["password"] = proxy.password
        launch_kwargs["proxy"] = proxy_dict
        if geoip:
            launch_kwargs["geoip"] = True

    return AsyncCamoufox(**launch_kwargs)

async def human_delay(min_ms: int = 400, max_ms: int = 1200):
    delay = random.uniform(min_ms / 1000.0, max_ms / 1000.0)
    await asyncio.sleep(delay)

async def human_type(page: Page, selector: str, text: str, min_delay_ms: int = 25, max_delay_ms: int = 70):
    element = await page.wait_for_selector(selector, timeout=15000)
    if not element:
        raise RuntimeError(f"Element not found for typing: {selector}")
    await element.click()
    await human_delay(150, 350)
    # Clear existing text if any
    await element.fill("")
    for char in text:
        await element.type(char, delay=random.randint(min_delay_ms, max_delay_ms))
    await human_delay(200, 500)
