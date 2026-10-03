import os
from typing import List, Optional, NamedTuple
from urllib.parse import urlparse

class Account(NamedTuple):
    email: str
    password: str
    recovery_email: Optional[str] = None

class Proxy(NamedTuple):
    server: str
    username: Optional[str] = None
    password: Optional[str] = None

def load_accounts(filepath: str) -> List[Account]:
    if not os.path.exists(filepath):
        return []
    accounts: List[Account] = []
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(":")
            if len(parts) >= 2:
                email = parts[0].strip()
                password = parts[1].strip()
                recovery = parts[2].strip() if len(parts) >= 3 else None
                if "@" in email:
                    accounts.append(Account(email=email, password=password, recovery_email=recovery))
    return accounts

def parse_proxy(line: str) -> Optional[Proxy]:
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    # Format: host:port:user:pass
    parts = line.split(":")
    if len(parts) == 4 and "://" not in line:
        host, port, user, pwd = parts
        return Proxy(server=f"http://{host}:{port}", username=user, password=pwd)

    # Format: user:pass@host:port
    if "@" in line and "://" not in line:
        line = f"http://{line}"

    valid_schemes = ("http://", "https://", "socks://", "socks4://", "socks4a://", "socks5://", "socks5h://")
    if any(line.startswith(scheme) for scheme in valid_schemes):
        parsed = urlparse(line)
        port = parsed.port
        if not port:
            netloc = parsed.netloc.split("@")[-1]
            if ":" in netloc:
                port_str = netloc.split(":")[-1]
                if port_str.isdigit():
                    port = int(port_str)
            if not port:
                if parsed.scheme == "https":
                    port = 443
                elif parsed.scheme.startswith("socks"):
                    port = 1080
        raw_scheme = parsed.scheme.lower()
        if raw_scheme in ("socks5h", "socks5"):
            scheme = "socks5"
        elif raw_scheme in ("socks4a", "socks4", "socks"):
            scheme = "socks4"
        else:
            scheme = raw_scheme
        server = f"{scheme}://{parsed.hostname}:{port}"
        return Proxy(server=server, username=parsed.username, password=parsed.password)

    if len(parts) == 2 and "://" not in line:
        return Proxy(server=f"http://{parts[0]}:{parts[1]}")

    return None

def load_proxies(filepath: str) -> List[Proxy]:
    if not os.path.exists(filepath):
        return []
    proxies: List[Proxy] = []
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = parse_proxy(line)
            if p:
                proxies.append(p)
    return proxies
