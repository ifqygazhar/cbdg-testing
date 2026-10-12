import json
import os
import time
from typing import Dict, Any, Optional, Set, Union, List
import re

class FlowState:
    PENDING = "PENDING"
    SIGNUP = "SIGNUP"
    DASHBOARD = "DASHBOARD"
    FREE_MODELS = "FREE_MODELS"
    TRIGGER_VERIFY = "TRIGGER_VERIFY"
    EMAIL_VERIFIED = "EMAIL_VERIFIED"
    API_KEY = "API_KEY"
    DONE = "DONE"
    FAILED = "FAILED"

class JsonlStore:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self._records: Dict[str, Dict[str, Any]] = {}
        self._load()

    def _load(self):
        if not os.path.exists(self.filepath):
            return
        with open(self.filepath, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    if "email" in record:
                        self._records[record["email"]] = record
                except Exception:
                    pass

    def get(self, email: str) -> Optional[Dict[str, Any]]:
        return self._records.get(email)

    def is_done(self, email: str) -> bool:
        record = self.get(email)
        return record is not None and record.get("status") == FlowState.DONE

    def is_restricted_or_banned(self, email: str) -> bool:
        record = self.get(email)
        if not record or record.get("status") != FlowState.FAILED:
            return False
        err = (record.get("error") or "").lower()
        return any(k in err for k in ["restricted", "disabled", "banned", "phone verification", "verifikasi nomor", "phone_verification"])

    def get_all_done_emails(self) -> Set[str]:
        return {
            email.lower() for email, rec in self._records.items()
            if rec.get("status") == FlowState.DONE
        }

    def get_all_failed_emails(self) -> Set[str]:
        return {
            email.lower() for email, rec in self._records.items()
            if rec.get("status") == FlowState.FAILED
        }

    def upsert(self, record: Dict[str, Any]):
        email = record.get("email")
        if not email:
            return
        record["updatedAt"] = int(time.time() * 1000)
        self._records[email] = record
        # Append to jsonl
        os.makedirs(os.path.dirname(os.path.abspath(self.filepath)), exist_ok=True)
        with open(self.filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

def read_emails_from_result_file(filepath: Union[str, List[str]]) -> Set[str]:
    emails: Set[str] = set()
    paths = [filepath] if isinstance(filepath, str) else filepath
    email_regex = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')
    for fp in paths:
        if not fp or not os.path.exists(fp):
            continue
        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                # Strip comment after # if preceded by space or colon
                main_part = line.split(" #")[0].strip() if " #" in line else line
                # Delimited by : or |
                parts = [p.strip() for p in main_part.replace("|", ":").split(":") if p.strip()]
                if parts and "@" in parts[0]:
                    emails.add(parts[0].lower().strip())
                else:
                    m = email_regex.search(line)
                    if m:
                        emails.add(m.group(0).lower().strip())
    return emails

class ResultWriter:
    def __init__(
        self,
        key_files: list[str],
        account_result_file: str,
        account_failed_file: str,
        fallback_result_files: Optional[List[str]] = None,
        fallback_failed_files: Optional[List[str]] = None,
    ):
        self.key_files = key_files
        self.account_result_file = account_result_file
        self.account_failed_file = account_failed_file
        self.fallback_result_files = fallback_result_files or []
        self.fallback_failed_files = fallback_failed_files or []

    def mark_success(self, email: str, password: str = "", api_key: str = "", extra: str = ""):
        # Save API key to key files
        for kf in self.key_files:
            if not kf or not api_key:
                continue
            os.makedirs(os.path.dirname(os.path.abspath(kf)), exist_ok=True)
            with open(kf, "a", encoding="utf-8") as f:
                f.write(f"{api_key}\n")

        # Save to account result file
        line = f"{email}:{password}" if password else email
        if api_key:
            line += f":{api_key}"
        if extra:
            line += f":{extra}"

        os.makedirs(os.path.dirname(os.path.abspath(self.account_result_file)), exist_ok=True)
        with open(self.account_result_file, "a", encoding="utf-8") as f:
            f.write(f"{line}\n")

    def mark_failed(self, email: str, password_or_reason: str = "", reason: str = ""):
        if not reason:
            pwd = ""
            err = password_or_reason
        else:
            pwd = password_or_reason
            err = reason

        os.makedirs(os.path.dirname(os.path.abspath(self.account_failed_file)), exist_ok=True)
        with open(self.account_failed_file, "a", encoding="utf-8") as f:
            line = f"{email}:{pwd} # {err}" if pwd else f"{email} # {err}"
            f.write(f"{line}\n")

    def markSuccess(self, email: str, password: str = "", api_key: str = "", extra: str = ""):
        return self.mark_success(email, password, api_key, extra)

    def markFailed(self, email: str, password_or_reason: str = "", reason: str = ""):
        return self.mark_failed(email, password_or_reason, reason)

    def get_successful_emails(self) -> Set[str]:
        target_files = [self.account_result_file] + [f for f in self.fallback_result_files if f != self.account_result_file]
        return read_emails_from_result_file(target_files)

    def get_failed_emails(self) -> Set[str]:
        target_files = [self.account_failed_file] + [f for f in self.fallback_failed_files if f != self.account_failed_file]
        return read_emails_from_result_file(target_files)

    def getSuccessfulEmails(self) -> Set[str]:
        return self.get_successful_emails()

    def getFailedEmails(self) -> Set[str]:
        return self.get_failed_emails()
