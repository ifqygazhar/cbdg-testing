import atexit
import os
import random
import signal
import subprocess
import sys
from typing import Optional, Dict, Any, List
from camoufox.async_api import AsyncCamoufox
from playwright.async_api import Browser, Page
from .loaders import Proxy

def get_descendant_pids(parent_pid: Optional[int] = None) -> List[int]:
    """Recursively retrieves all child PIDs of a given parent process."""
    if parent_pid is None:
        parent_pid = os.getpid()
    descendants: List[int] = []
    try:
        out = subprocess.check_output(
            ["pgrep", "-P", str(parent_pid)],
            stderr=subprocess.DEVNULL
        ).decode().split()
        for c in out:
            cid = int(c)
            descendants.append(cid)
            descendants.extend(get_descendant_pids(cid))
    except Exception:
        pass
    return descendants

def kill_descendant_processes(sig: signal.Signals = signal.SIGKILL) -> None:
    """Kills all descendant processes (Node driver, Camoufox/Firefox binaries, content procs)."""
    pids = get_descendant_pids()
    for pid in reversed(pids):
        try:
            os.kill(pid, sig)
        except OSError:
            pass

def _cleanup_on_exit():
    kill_descendant_processes(signal.SIGKILL)

_signals_initialized = False

def setup_process_signals():
    """
    Installs clean shutdown signal handlers for SIGINT, SIGTERM, SIGHUP,
    and atexit so that Ctrl+C or parent termination immediately kills all
    browser processes and never leaves zombie or orphan processes.
    """
    global _signals_initialized
    if _signals_initialized:
        return
    _signals_initialized = True

    atexit.register(_cleanup_on_exit)

    def handle_signal(signum, frame):
        print(f"\n[camoufox] Signal {signum} received, terminating browser and child processes...", file=sys.stderr)
        kill_descendant_processes(signal.SIGKILL)
        os._exit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            signal.signal(sig, handle_signal)
        except (ValueError, OSError):
            pass

async def launch_camoufox(
    headless: bool = True,
    proxy: Optional[Proxy] = None,
    geoip: bool = True,
    **kwargs
) -> AsyncCamoufox:
    setup_process_signals()
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
