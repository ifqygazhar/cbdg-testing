"""
TempMail-Pro Client for Python / Camoufox automation.
Handles email creation, inbox polling, verification link extraction, and deletion.
"""

import asyncio
import os
import re
import urllib.request
import urllib.parse
import json
from typing import Optional, List, Dict, Any

class TempMailClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_domain: Optional[str] = None,
    ):
        raw_base = base_url or os.getenv("TEMPMAIL_BASE_URL", "https://temp.ifqy.net")
        if not raw_base.startswith("http"):
            raw_base = f"https://{raw_base}"
        self.base_url = raw_base.rstrip("/")
        self.api_key = api_key or os.getenv("TEMPMAIL_API_KEY", "anjingmemekkontol")
        dom = default_domain or os.getenv("TEMPMAIL_DOMAIN", "ifqy.net")
        if dom.startswith("temp."):
            dom = dom[5:]
        self.default_domain = dom

    def _headers(self) -> Dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "Content-Type": "application/json",
            "User-Agent": "CBDG-TempMail-Client/1.0",
        }

    def create_email(self, domain: Optional[str] = None, username: Optional[str] = None) -> Dict[str, Any]:
        """Creates a new temporary email address."""
        target_domain = domain or self.default_domain
        if target_domain.startswith("temp."):
            target_domain = target_domain[5:]
        if "://" in target_domain:
            target_domain = target_domain.split("://")[1].split("/")[0]
            if target_domain.startswith("temp."):
                target_domain = target_domain[5:]
        payload: Dict[str, str] = {"domain": target_domain}
        if username:
            payload["username"] = username

        url = f"{self.base_url}/api/email/create"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") != "ok" or not data.get("data", {}).get("email"):
                raise RuntimeError(f"TempMail create_email failed: {data}")
            return data["data"]

    def get_inbox(self, address: str) -> List[Dict[str, Any]]:
        """Retrieves list of received messages for an address."""
        url = f"{self.base_url}/api/email/inbox?address={urllib.parse.quote(address)}"
        req = urllib.request.Request(
            url,
            headers={"x-api-key": self.api_key, "User-Agent": "CBDG-TempMail-Client/1.0"},
            method="GET",
        )

        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("mails", [])
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            raise

    async def wait_for_verification_link(
        self,
        address: str,
        timeout_sec: int = 75,
        interval_sec: float = 3.0,
        filter_sender: str = "",
        link_pattern: Optional[re.Pattern] = None,
    ) -> str:
        """Polls inbox until verification email arrives and returns the link."""
        pattern = link_pattern or re.compile(r"https?://[^\s\"'<>]+verify[^\s\"'<>]+")
        filter_sender_lower = filter_sender.lower().strip() if filter_sender else ""
        start_time = asyncio.get_event_loop().time()

        while asyncio.get_event_loop().time() - start_time < timeout_sec:
            try:
                mails = await asyncio.to_thread(self.get_inbox, address)
                for mail in mails:
                    sender = mail.get("sender", "").lower()
                    if not filter_sender_lower or filter_sender_lower in sender:
                        body = f"{mail.get('content-plain', '')} {mail.get('content-html', '')}"
                        match = pattern.search(body)
                        if match:
                            clean_link = match.group(0).rstrip(")>]\"',.")
                            return clean_link
            except Exception:
                pass

            await asyncio.sleep(interval_sec)

        raise TimeoutError(f"Verification email for {address} did not arrive within {timeout_sec}s")

    async def wait_for_verification_otp(
        self,
        address: str,
        timeout_sec: int = 75,
        interval_sec: float = 3.0,
        filter_sender: str = "",
        code_pattern: Optional[re.Pattern] = None,
    ) -> str:
        """Polls inbox until verification email arrives and returns the 6-digit OTP code."""
        filter_sender_lower = filter_sender.lower() if filter_sender else ""
        start_time = asyncio.get_event_loop().time()

        while asyncio.get_event_loop().time() - start_time < timeout_sec:
            try:
                mails = await asyncio.to_thread(self.get_inbox, address)
                for mail in mails:
                    sender = mail.get("sender", "").lower()
                    if not filter_sender_lower or filter_sender_lower in sender:
                        body = f"{mail.get('content-plain', '')} {mail.get('content-html', '')}"
                        # 1. Match bold 6 digits in html
                        m_bold = re.search(r"<b>\s*(\d{6})\s*</b>", body)
                        if m_bold:
                            return m_bold.group(1)

                        # 2. Strip HTML tags to avoid false positives with CSS hex colors (#111827, #000000)
                        clean_text = re.sub(r"<[^>]+>", " ", body)
                        m_prompt = re.search(
                            r"(?:verification code|enter the following|code when prompted)[\s\S]{0,100}?(\d{6})",
                            clean_text,
                            re.I,
                        )
                        if m_prompt:
                            return m_prompt.group(1)

                        # 3. Match explicit code_pattern or standalone 6 digits
                        if code_pattern:
                            m_custom = code_pattern.search(clean_text)
                            if m_custom:
                                code = m_custom.group(1) if m_custom.groups() else m_custom.group(0)
                                if re.match(r"^\d{6}$", code):
                                    return code
                        else:
                            m_any = re.search(r"\b(\d{6})\b", clean_text)
                            if m_any:
                                return m_any.group(1)
            except Exception:
                pass

            await asyncio.sleep(interval_sec)

        raise TimeoutError(f"Verification code for {address} did not arrive within {timeout_sec}s")

    def delete_email(self, address: str) -> bool:
        """Deletes email address and all its messages."""
        url = f"{self.base_url}/api/email/delete?address={urllib.parse.quote(address)}"
        req = urllib.request.Request(
            url,
            headers={"x-api-key": self.api_key, "User-Agent": "CBDG-TempMail-Client/1.0"},
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status == 200
        except Exception:
            return False
