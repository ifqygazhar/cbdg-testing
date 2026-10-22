import json
import sys
from datetime import datetime, timezone

class Logger:
    def __init__(self, email: str = ""):
        self.email = email

    def _log(self, level: str, msg: str, **extra):
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            **({"email": self.email} if self.email else {}),
            "msg": msg,
            **extra
        }
        sys.stderr.write(json.dumps(record) + "\n")
        sys.stderr.flush()

    def info(self, msg: str, **extra):
        self._log("info", msg, **extra)

    def warn(self, msg: str, **extra):
        self._log("warn", msg, **extra)

    def warning(self, msg: str, **extra):
        self._log("warn", msg, **extra)

    def error(self, msg: str, **extra):
        self._log("error", msg, **extra)

    def debug(self, msg: str, **extra):
        self._log("debug", msg, **extra)

def create_logger(email: str = "") -> Logger:
    return Logger(email)
