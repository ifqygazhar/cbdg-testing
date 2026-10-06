import asyncio
import atexit
import os
import random
import re
import signal
import subprocess
import sys
from typing import Optional, Dict, Any, List, Union
from urllib.parse import urlparse
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

POPULAR_RESOLUTIONS = [
    (1920, 1080),
    (1366, 768),
    (1536, 864),
    (1440, 900),
    (1600, 900),
    (2560, 1440),
    (1680, 1050),
    (1280, 800),
    (1920, 1200),
]

def generate_random_fingerprint_options() -> Dict[str, Any]:
    """
    Generates randomized OS, screen window, humanize, and locale parameters
    to ensure every worker process and account gets a unique, anonymous fingerprint.
    """
    # Weighted OS selection: Windows (60%), macOS (30%), Linux (10%)
    os_choice = random.choices(["windows", "macos", "linux"], weights=[0.60, 0.30, 0.10], k=1)[0]

    # Randomize realistic window dimensions
    base_w, base_h = random.choice(POPULAR_RESOLUTIONS)
    jitter_w = max(1024, base_w - random.randint(0, 100))
    jitter_h = max(700, base_h - random.randint(40, 120))

    # Randomize humanize cursor speed between 0.8s and 1.8s
    humanize_speed = round(random.uniform(0.8, 1.8), 2)

    return {
        "os": os_choice,
        "window": (jitter_w, jitter_h),
        "humanize": humanize_speed,
    }

async def get_browser_fingerprint_info(page: Page) -> Dict[str, Any]:
    """
    Retrieves the active fingerprint information (UA, Platform, Screen, Viewport, Cores)
    rendered inside the Camoufox page session.
    """
    try:
        return await page.evaluate("""() => ({
            ua: navigator.userAgent || 'unknown',
            platform: navigator.platform || 'unknown',
            cores: navigator.hardwareConcurrency || 0,
            screen: (screen.width || 0) + 'x' + (screen.height || 0),
            viewport: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
        })""")
    except Exception:
        return {}

async def launch_camoufox(
    headless: bool = True,
    proxy: Optional[Proxy] = None,
    geoip: Union[bool, str] = True,
    randomize_fingerprint: bool = True,
    **kwargs
) -> AsyncCamoufox:
    setup_process_signals()

    fp_opts = generate_random_fingerprint_options() if randomize_fingerprint else {}

    launch_kwargs: Dict[str, Any] = {
        "headless": headless,
        **fp_opts,
        **kwargs
    }

    if proxy:
        if proxy.server.lower().startswith("socks") and (proxy.username or proxy.password):
            print(
                f"[camoufox] PERINGATAN: Playwright / Firefox tidak mendukung autentikasi user:pass pada proxy SOCKS ({proxy.server}). "
                f"Gunakan IP Whitelist pada provider proxy agar bisa diakses tanpa user:pass, atau gunakan format HTTP proxy.",
                file=sys.stderr,
            )
        proxy_dict: Dict[str, str] = {"server": proxy.server}
        if proxy.username:
            proxy_dict["username"] = proxy.username
        if proxy.password:
            proxy_dict["password"] = proxy.password

        # Configure proxy bypass if GOOGLE_DIRECT is enabled
        google_direct = os.getenv("GOOGLE_DIRECT", "1").lower() in ("1", "true", "yes", "y")
        bypass = kwargs.pop("bypass", None)
        if not bypass and google_direct:
            env_hosts = os.getenv("GOOGLE_DIRECT_HOSTS", "")
            hosts_list = [h.strip() for h in re.split(r"[;,\s]+", env_hosts) if h.strip()]
            default_bypass = ["accounts.google.com", "ssl.gstatic.com", "www.gstatic.com", "mail.google.com", "gmail.com"]
            combined = list(dict.fromkeys(hosts_list + default_bypass))
            bypass = ",".join(combined)

        if bypass:
            proxy_dict["bypass"] = bypass

        launch_kwargs["proxy"] = proxy_dict
        if geoip:
            if isinstance(geoip, str):
                launch_kwargs["geoip"] = geoip
            else:
                # Do NOT pass geoip=True directly when using a proxy.
                # Camoufox's default geoip=True sends synchronous requests via python `requests`
                # to external IP check endpoints with verify=True, which crashes with
                # SSLCertVerificationError on proxies with certificate mismatches (e.g. IP vs host),
                # or hangs indefinitely on SOCKS5 proxies.
                # Passing the proxy host IP directly allows Camoufox to use its bundled offline
                # MaxMind database immediately in milliseconds without network calls.
                host = None
                try:
                    parsed = urlparse(proxy.server)
                    host = parsed.hostname
                except Exception:
                    pass

                if host and re.match(r"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$", host):
                    launch_kwargs["geoip"] = host
                else:
                    launch_kwargs["geoip"] = False

    try:
        return AsyncCamoufox(**launch_kwargs)
    except Exception as e:
        if "does not support socks5 proxy authentication" in str(e).lower():
            raise RuntimeError(
                f"Proxy SOCKS5 '{proxy.server if proxy else ''}' ditolak browser karena memakai username/password. "
                f"Playwright & Firefox tidak mendukung autentikasi SOCKS5 secara native. "
                f"Solusi: Aktifkan IP Whitelist di provider proxy (agar proxy bisa diakses tanpa user/pass) atau gunakan format HTTP proxy."
            ) from e
        raise

async def human_delay(min_ms: int = 400, max_ms: int = 1200):
    delay = random.uniform(min_ms / 1000.0, max_ms / 1000.0)
    await asyncio.sleep(delay)

async def human_type(page: Page, selector: str, text: str, min_delay_ms: int = 50, max_delay_ms: int = 120, timeout: int = 30000):
    element = await page.wait_for_selector(selector, timeout=timeout)
    if not element:
        raise RuntimeError(f"Element not found for typing: {selector}")
    try:
        await element.click(no_wait_after=True, timeout=10000)
    except Exception:
        await element.click(force=True, no_wait_after=True, timeout=5000)
    await human_delay(250, 500)
    # Clear existing text if any
    await element.fill("")
    await human_delay(150, 300)
    for char in text:
        # Subtle human cadence: slight pause on symbols and numbers, plus occasional micro-pauses
        if char in "@._-1234567890!#" or random.random() < 0.08:
            await human_delay(100, 250)
        await element.type(char, delay=random.randint(min_delay_ms, max_delay_ms))
    await human_delay(300, 600)
