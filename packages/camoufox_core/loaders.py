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
    if len(parts) == 4 and not line.startswith("http"):
        host, port, user, pwd = parts
        return Proxy(server=f"http://{host}:{port}", username=user, password=pwd)

    # Format: user:pass@host:port
    if "@" in line and not line.startswith("http"):
        line = f"http://{line}"

    if line.startswith("http://") or line.startswith("https://") or line.startswith("socks5://"):
        parsed = urlparse(line)
        server = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}" if parsed.port else f"{parsed.scheme}://{parsed.hostname}"
        return Proxy(server=server, username=parsed.username, password=parsed.password)

    if len(parts) == 2:
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
