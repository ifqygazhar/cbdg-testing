import asyncio
import atexit
import gc
import glob
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time
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

def cleanup_leftover_browser_processes() -> int:
    """
    Specifically targets and terminates orphan/stale browser child processes (camoufox, firefox, node)
    that remain lingering under the current process without killing unrelated tasks.
    Returns number of killed processes.
    """
    pids = get_descendant_pids()
    killed = 0
    for pid in reversed(pids):
        try:
            cmd = ""
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            if any(k in cmd.lower() for k in ["camoufox", "firefox", "playwright", "node"]):
                os.kill(pid, signal.SIGKILL)
                killed += 1
        except Exception:
            pass
    return killed

def cleanup_temp_profiles(max_age_sec: int = 60) -> int:
    """
    Purges abandoned Playwright / Camoufox temporary profiles and artifacts in /tmp
    to prevent disk and tmpfs full errors on resource-constrained VPS environments.
    """
    patterns = ["/tmp/playwright*", "/tmp/camoufox*"]
    cleaned = 0
    now = time.time()
    for pat in patterns:
        for path in glob.glob(pat):
            try:
                st = os.stat(path)
                if now - st.st_mtime > max_age_sec:
                    if os.path.isdir(path):
                        shutil.rmtree(path, ignore_errors=True)
                    else:
                        os.remove(path)
                    cleaned += 1
            except Exception:
                pass
    return cleaned

def get_vps_system_status() -> str:
    """
    Reads Linux /proc/meminfo and child process count to provide real-time VPS resource diagnostics.
    """
    mem_str = "unknown"
    try:
        with open("/proc/meminfo", "r") as f:
            lines = {line.split(":")[0].strip(): int(line.split(":")[1].split()[0]) for line in f if ":" in line}
        total = lines.get("MemTotal", 0) // 1024
        avail = lines.get("MemAvailable", 0) // 1024
        used = total - avail
        pct = round(used / total * 100, 1) if total > 0 else 0
        mem_str = f"{used}MB/{total}MB ({pct}%)"
    except Exception:
        pass

    proc_count = len(get_descendant_pids())
    return f"RAM: {mem_str} | Child procs: {proc_count}"

async def safe_close_browser(target: Any, timeout_sec: float = 6.0) -> None:
    """
    Safely closes a Playwright Browser or BrowserContext instance with an explicit timeout
    to prevent indefinite hanging if IPC or socket is deadlocked.
    """
    if not target:
        return
    try:
        if hasattr(target, "close"):
            res = target.close()
            if asyncio.iscoroutine(res):
                await asyncio.wait_for(res, timeout=timeout_sec)
    except Exception:
        pass
    finally:
        gc.collect()

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

_DIVERSE_OS_SEQUENCE = ["windows", "macos", "windows", "linux", "macos", "windows"]
_OS_CYCLE_INDEX = random.randint(0, 5)

def generate_random_fingerprint_options(target_os: Optional[str] = None) -> Dict[str, Any]:
    """
    Generates randomized OS, screen window, humanize, and locale parameters
    to ensure every worker process and account gets a unique, anonymous fingerprint.
    """
    global _OS_CYCLE_INDEX
    if target_os:
        os_choice = target_os
    else:
        # Rotate OS sequence so consecutive accounts receive distinct operating systems & profiles
        os_choice = _DIVERSE_OS_SEQUENCE[_OS_CYCLE_INDEX % len(_DIVERSE_OS_SEQUENCE)]
        _OS_CYCLE_INDEX += 1

    # Randomize realistic window dimensions
    base_w, base_h = random.choice(POPULAR_RESOLUTIONS)
    jitter_w = max(1024, base_w - random.randint(0, 120))
    jitter_h = max(700, base_h - random.randint(40, 140))

    # Randomize humanize cursor speed between 0.8s and 1.8s
    humanize_speed = round(random.uniform(0.8, 1.8), 2)

    return {
        "os": os_choice,
        "window": (jitter_w, jitter_h),
        "humanize": humanize_speed,
    }

async def get_browser_fingerprint_info(page: Page) -> Dict[str, Any]:
    """
    Retrieves the active fingerprint information (UA, Platform, Screen, Viewport, Cores, GPU renderer)
    rendered inside the Camoufox page session.
    """
    try:
        return await page.evaluate("""() => {
            let renderer = 'unknown';
            try {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    const ext = gl.getExtension('WEBGL_debug_renderer_info');
                    if (ext) {
                        renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'unknown';
                    }
                }
            } catch(e) {}
            return {
                ua: navigator.userAgent || 'unknown',
                platform: navigator.platform || 'unknown',
                cores: navigator.hardwareConcurrency || 0,
                memory: navigator.deviceMemory || undefined,
                screen: (screen.width || 0) + 'x' + (screen.height || 0),
                viewport: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
                renderer: renderer,
            };
        }""")
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
            default_bypass = [
                "localhost",
                "127.0.0.1",
                "google.com",
                "mail.google.com",
                "accounts.google.com",
                "gmail.com",
                "gstatic.com",
                "googleusercontent.com",
                "googleapis.com",
                "youtube.com",
                "play.google.com",
                "myaccount.google.com",
            ]
            clean_hosts = []
            for h in hosts_list + default_bypass:
                cleaned = h.strip().lstrip("*.").strip()
                if cleaned and cleaned not in clean_hosts:
                    clean_hosts.append(cleaned)
            bypass = ",".join(clean_hosts)

        if bypass:
            proxy_dict["bypass"] = bypass
            user_prefs = launch_kwargs.get("firefox_user_prefs", {}) or {}
            user_prefs["network.proxy.no_proxies_on"] = bypass
            launch_kwargs["firefox_user_prefs"] = user_prefs

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
                    if host.startswith(("127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.")):
                        launch_kwargs["geoip"] = False
                    else:
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
        if "ip not found in database" in str(e).lower() and launch_kwargs.get("geoip"):
            launch_kwargs["geoip"] = False
            return AsyncCamoufox(**launch_kwargs)
        raise

async def human_delay(min_ms: int = 400, max_ms: int = 1200, pace: Optional[str] = None, **kwargs):
    multiplier = 0.6 if pace == "fast" else (1.5 if pace == "careful" else 1.0)
    delay = random.uniform((min_ms * multiplier) / 1000.0, (max_ms * multiplier) / 1000.0)
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
