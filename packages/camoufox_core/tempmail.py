"""
TempMail-Pro Client for Python / Camoufox automation.
Handles email creation, inbox polling, verification link extraction, and deletion.
Includes dual-endpoint failover, browser-grade headers to prevent Cloudflare 403,
multi-strategy link extraction, and robust logging.
"""

import asyncio
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

DEFAULT_BASE_URL = "https://temp-postservice.verifwebsitepro.workers.dev"

def extract_link_from_mail(
    mail: Dict[str, Any],
    pattern: Optional[re.Pattern] = None,
    target_domain: str = "",
) -> str:
    """
    Extracts verification/activation URL from a TempMail message object using multiple fallback strategies:
    1. Direct Regex pattern search over unescaped plain & HTML content.
    2. HTML <a> tag analysis looking for 'verify', 'confirm', 'activate' anchor text or href.
    3. Target domain verification URL heuristic matching.
    4. General verification URL heuristic matching.
    """
    fields = ["content-plain", "content-html", "content-plain-formatted", "body", "html", "text"]
    texts = [str(mail.get(f, "")) for f in fields if mail.get(f)]
    combined_raw = "\n".join(texts)
    combined = html.unescape(combined_raw)

    # 1. Direct pattern match if provided
    if pattern:
        m = pattern.search(combined)
        if m:
            link = m.group(1) if m.groups() else m.group(0)
            return link.rstrip(")>]\"'.,")

    # 2. Extract from <a> href tags with verify or confirm
    a_tags = re.findall(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', combined_raw, re.I | re.S)
    for href, text in a_tags:
        clean_href = html.unescape(href).strip()
        if target_domain and target_domain in clean_href and ("verify" in clean_href.lower() or "token" in clean_href.lower()):
            return clean_href.rstrip(")>]\"'.,")
        if any(w in text.lower() for w in ["verify", "confirm", "activate", "verifikasi", "get started", "proceed"]):
            if clean_href.startswith("http"):
                return clean_href.rstrip(")>]\"'.,")

    # 3. Match any URL that contains target_domain and (verify or token)
    if target_domain:
        m_dom = re.search(r"https?://[^\s\"'<>]*" + re.escape(target_domain) + r"[^\s\"'<>]+(?:verify|token)[^\s\"'<>]+", combined, re.I)
        if m_dom:
            return m_dom.group(0).rstrip(")>]\"'.,")

    # 4. Fallback: match any verify or token URL
    m_any = re.search(r"https?://[^\s\"'<>]+(?:verify-email|verify|verification|token=)[^\s\"'<>]+", combined, re.I)
    if m_any:
        return m_any.group(0).rstrip(")>]\"'.,")

    return ""


class TempMailClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_domain: Optional[str] = None,
    ):
        raw_base = base_url or os.getenv("TEMPMAIL_BASE_URL", DEFAULT_BASE_URL)
        if not raw_base.startswith("http"):
            raw_base = f"https://{raw_base}"
        self.base_url = raw_base.rstrip("/")
        self.api_key = api_key or os.getenv("TEMPMAIL_API_KEY", "anjingmemekkontol")
        dom = default_domain or os.getenv("TEMPMAIL_DOMAIN", "ifqy.net")
        if dom.startswith("temp."):
            dom = dom[5:]
        self.default_domain = dom.lower().strip()

    def _headers(self) -> Dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        }

    def _make_request(
        self,
        path: str,
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None,
        timeout: float = 15.0,
    ) -> Any:
        clean_path = path.lstrip("/")
        headers = self._headers()
        payload = json.dumps(data).encode("utf-8") if data is not None else None
        url = f"{self.base_url}/{clean_path}"
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp_bytes = resp.read().decode("utf-8")
                if not resp_bytes.strip():
                    return {}
                return json.loads(resp_bytes)
        except urllib.error.HTTPError as e:
            # 404 on inbox endpoint simply means empty inbox
            if "inbox" in path and e.code == 404:
                return {"status": "ok", "mails": []}
            raise


    def create_email(self, domain: Optional[str] = None, username: Optional[str] = None) -> Dict[str, Any]:
        """Creates a new temporary email address."""
        target_domain = (domain or self.default_domain or "ifqy.net").lower().strip().lstrip("@")
        if target_domain.startswith("temp."):
            target_domain = target_domain[5:]
        if "://" in target_domain:
            target_domain = target_domain.split("://")[1].split("/")[0]
            if target_domain.startswith("temp."):
                target_domain = target_domain[5:]
        target_domain = target_domain.lstrip("@").strip()

        payload: Dict[str, str] = {"domain": target_domain}
        if username:
            payload["username"] = username.strip().lower()

        data = self._make_request("api/email/create", method="POST", data=payload, timeout=20.0)
        if data.get("status") != "ok" or not data.get("data", {}).get("email"):
            raise RuntimeError(f"TempMail create_email failed: {data}")
        return data["data"]

    def get_inbox(self, address: str) -> List[Dict[str, Any]]:
        """Retrieves list of received messages for an address."""
        clean_address = address.strip().lower()
        data = self._make_request(f"api/email/inbox?address={urllib.parse.quote(clean_address)}", method="GET", timeout=15.0)
        return data.get("mails", [])

    async def wait_for_verification_link(
        self,
        address: str,
        timeout_sec: int = 120,
        interval_sec: float = 3.0,
        filter_sender: str = "",
        link_pattern: Optional[re.Pattern] = None,
        target_domain: str = "",
        logger: Any = None,
    ) -> str:
        """Polls inbox until verification email arrives and returns the link."""
        clean_address = address.strip().lower()
        filter_sender_lower = filter_sender.lower().strip() if filter_sender else ""
        start_time = asyncio.get_event_loop().time()
        last_log_time = start_time

        if logger:
            logger.info(f"polling TempMail inbox for {clean_address} (timeout: {timeout_sec}s, interval: {interval_sec}s)...")

        while asyncio.get_event_loop().time() - start_time < timeout_sec:
            elapsed = int(asyncio.get_event_loop().time() - start_time)
            try:
                mails = await asyncio.to_thread(self.get_inbox, clean_address)
                if mails:
                    if logger:
                        senders = [m.get("sender", "") for m in mails]
                        subjects = [m.get("subject", "") for m in mails]
                        logger.info(f"📬 TempMail: {len(mails)} message(s) in inbox for {clean_address}. From: {senders}, Subj: {subjects}")

                    for mail in mails:
                        sender = mail.get("sender", "").lower()
                        subject = mail.get("subject", "").lower()
                        if not filter_sender_lower or (filter_sender_lower in sender or filter_sender_lower in subject):
                            clean_link = extract_link_from_mail(
                                mail,
                                pattern=link_pattern,
                                target_domain=target_domain,
                            )
                            if clean_link:
                                if logger:
                                    logger.info(f"✅ Found verification link for {clean_address}: {clean_link}")
                                return clean_link

            except Exception as e:
                if logger and (asyncio.get_event_loop().time() - last_log_time >= 15):
                    logger.warning(f"⚠️ TempMail get_inbox error for {clean_address}: {e}")

            if logger and (asyncio.get_event_loop().time() - last_log_time >= 12):
                logger.info(f"⏳ still waiting for verification email on {clean_address} ({elapsed}s/{timeout_sec}s elapsed)...")
                last_log_time = asyncio.get_event_loop().time()

            await asyncio.sleep(interval_sec)

        raise TimeoutError(f"Verification email for {clean_address} did not arrive within {timeout_sec}s")

    async def wait_for_verification_otp(
        self,
        address: str,
        timeout_sec: int = 120,
        interval_sec: float = 3.0,
        filter_sender: str = "",
        code_pattern: Optional[re.Pattern] = None,
        logger: Any = None,
    ) -> str:
        """Polls inbox until verification email arrives and returns the 6-digit OTP code."""
        clean_address = address.strip().lower()
        filter_sender_lower = filter_sender.lower().strip() if filter_sender else ""
        start_time = asyncio.get_event_loop().time()
        last_log_time = start_time

        if logger:
            logger.info(f"polling TempMail inbox for OTP code on {clean_address} (timeout: {timeout_sec}s)...")

        while asyncio.get_event_loop().time() - start_time < timeout_sec:
            elapsed = int(asyncio.get_event_loop().time() - start_time)
            try:
                mails = await asyncio.to_thread(self.get_inbox, clean_address)
                if mails:
                    if logger:
                        logger.info(f"📬 TempMail: {len(mails)} message(s) in inbox for {clean_address}")
                    for mail in mails:
                        sender = mail.get("sender", "").lower()
                        subject = mail.get("subject", "").lower()
                        if not filter_sender_lower or (filter_sender_lower in sender or filter_sender_lower in subject):
                            body = f"{mail.get('subject', '')} {mail.get('content-plain', '')} {mail.get('content-html', '')}"
                            import html
                            unescaped = html.unescape(body)

                            # 1. Match bold 6 digits in html
                            m_bold = re.search(r"<(?:b|strong|span|div)[^>]*>\s*(\d{6})\s*</(?:b|strong|span|div)>", unescaped, re.I)
                            if m_bold:
                                return m_bold.group(1)

                            # 2. Strip HTML tags and collapse whitespace to avoid large gap timeouts
                            clean_text = re.sub(r"<[^>]+>", " ", unescaped)
                            norm_text = re.sub(r"\s+", " ", clean_text)
                            m_prompt = re.search(
                                r"(?:verification code|enter the following|code when prompted|code to continue|enter this temporary)[\s\S]{0,400}?(\d{6})",
                                norm_text,
                                re.I,
                            )
                            if m_prompt:
                                return m_prompt.group(1)

                            # 3. Match explicit code_pattern on both normalized and clean text
                            if code_pattern:
                                m_custom = code_pattern.search(norm_text) or code_pattern.search(clean_text)
                                if m_custom:
                                    code = m_custom.group(1) if m_custom.groups() else m_custom.group(0)
                                    if re.match(r"^\d{6}$", code):
                                        return code

                            # 4. Standalone 6-digit line in plain text
                            m_line = re.search(r"^\s*(\d{6})\s*$", mail.get("content-plain", ""), re.M)
                            if m_line:
                                return m_line.group(1)

                            # 5. Fallback 6 digits
                            m_any = re.search(r"\b(\d{6})\b", norm_text)
                            if m_any:
                                return m_any.group(1)
            except Exception as e:
                if logger and (asyncio.get_event_loop().time() - last_log_time >= 15):
                    logger.warning(f"⚠️ TempMail get_inbox error for {clean_address}: {e}")

            if logger and (asyncio.get_event_loop().time() - last_log_time >= 12):
                logger.info(f"⏳ still waiting for OTP code on {clean_address} ({elapsed}s/{timeout_sec}s elapsed)...")
                last_log_time = asyncio.get_event_loop().time()

            await asyncio.sleep(interval_sec)

        raise TimeoutError(f"Verification code for {clean_address} did not arrive within {timeout_sec}s")

    def delete_email(self, address: str) -> bool:
        """Deletes email address and all its messages."""
        clean_address = address.strip().lower()
        try:
            res = self._make_request(f"api/email/delete?address={urllib.parse.quote(clean_address)}", method="DELETE", timeout=15.0)
            return res.get("status") == "ok" or res.get("code") == 200
        except Exception:
            return False
