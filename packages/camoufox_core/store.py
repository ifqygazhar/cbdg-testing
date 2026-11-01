import json
import os
import time
from typing import Dict, Any, Optional, Set, Union, List
import re

class FlowState:
    PENDING = "PENDING"
    SIGNUP = "SIGNUP"
    OTP_SENT = "OTP_SENT"
    EMAIL_VERIFIED = "EMAIL_VERIFIED"
    LEGAL_ACCEPTED = "LEGAL_ACCEPTED"
    OVERVIEW = "OVERVIEW"
    DASHBOARD = "DASHBOARD"
    ONBOARDING = "ONBOARDING"
    FREE_MODELS = "FREE_MODELS"
    TRIGGER_VERIFY = "TRIGGER_VERIFY"
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

    def is_done(self, email: str, require_api_key: bool = False) -> bool:
        record = self.get(email)
        if not record or record.get("status") != FlowState.DONE:
            return False
        if require_api_key:
            return bool(record.get("apiKey"))
        return True

    def is_restricted_or_banned(self, email: str) -> bool:
        record = self.get(email)
        if not record or record.get("status") != FlowState.FAILED:
            return False
        err = (record.get("error") or "").lower()
        return any(k in err for k in ["restricted", "disabled", "banned", "phone verification", "verifikasi nomor", "phone_verification"])

    def get_all_done_emails(self, require_api_key: bool = False) -> Set[str]:
        return {
            email.lower() for email, rec in self._records.items()
            if rec.get("status") == FlowState.DONE and (not require_api_key or bool(rec.get("apiKey")))
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

def read_emails_from_result_file(filepath: Union[str, List[str]], require_api_key: bool = False) -> Set[str]:
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
                    email = parts[0].lower().strip()
                    if require_api_key:
                        has_key = any(p.startswith("thk_") or (len(p) > 25 and p != "ALREADY_REGISTERED") for p in parts[1:])
                        if has_key:
                            emails.add(email)
                    else:
                        emails.add(email)
                else:
                    m = email_regex.search(line)
                    if m and not require_api_key:
                        emails.add(m.group(0).lower().strip())
    return emails

def load_already_registered_accounts(filepath: Union[str, List[str]]) -> List[Dict[str, str]]:
    """
    Extracts accounts from result files that are marked as ALREADY_REGISTERED
    and do not yet have a valid thk_ API key.
    Returns list of dict: [{'email': ..., 'password': ...}]
    """
    accounts: List[Dict[str, str]] = []
    seen = set()
    paths = [filepath] if isinstance(filepath, str) else filepath
    for fp in paths:
        if not fp or not os.path.exists(fp):
            continue
        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                main_part = line.split(" #")[0].strip() if " #" in line else line
                parts = [p.strip() for p in main_part.replace("|", ":").split(":") if p.strip()]
                if len(parts) >= 2 and "@" in parts[0]:
                    email = parts[0].strip()
                    pwd = parts[1].strip()
                    norm_email = email.lower()
                    has_key = any(p.startswith("thk_") for p in parts[2:])
                    is_already_reg = any(p == "ALREADY_REGISTERED" for p in parts[2:])
                    if (is_already_reg or not has_key) and norm_email not in seen:
                        seen.add(norm_email)
                        accounts.append({"email": email, "password": pwd})
    return accounts

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

        # Save to account result file (in-place replacement if email already exists, e.g. upgrading ALREADY_REGISTERED)
        line = f"{email}:{password}" if password else email
        if api_key:
            line += f":{api_key}"
        if extra:
            line += f":{extra}"

        os.makedirs(os.path.dirname(os.path.abspath(self.account_result_file)), exist_ok=True)
        norm_email = email.lower().strip()
        updated = False
        if os.path.exists(self.account_result_file):
            lines = []
            with open(self.account_result_file, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            new_lines = []
            for l in lines:
                l_str = l.strip()
                if l_str:
                    main = l_str.split(" #")[0].strip() if " #" in l_str else l_str
                    parts = [p.strip() for p in main.replace("|", ":").split(":") if p.strip()]
                    if parts and parts[0].lower() == norm_email:
                        new_lines.append(f"{line}\n")
                        updated = True
                        continue
                new_lines.append(l)

            if updated:
                with open(self.account_result_file, "w", encoding="utf-8") as f:
                    f.writelines(new_lines)

        if not updated:
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

    def get_successful_emails(self, require_api_key: bool = False) -> Set[str]:
        target_files = [self.account_result_file] + [f for f in self.fallback_result_files if f != self.account_result_file]
        return read_emails_from_result_file(target_files, require_api_key=require_api_key)

    def get_failed_emails(self) -> Set[str]:
        target_files = [self.account_failed_file] + [f for f in self.fallback_failed_files if f != self.account_failed_file]
        return read_emails_from_result_file(target_files)

    def getSuccessfulEmails(self, require_api_key: bool = False) -> Set[str]:
        return self.get_successful_emails(require_api_key=require_api_key)

    def getFailedEmails(self) -> Set[str]:
        return self.get_failed_emails()
