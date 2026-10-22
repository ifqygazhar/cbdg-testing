# TempMail Integration & Email Verification Guide

This reference documents the pattern for using temporary disposable email addresses (TempMail-Pro API) in automated browser registration flows (e.g. TokenHarbor, GroqCloud, custom SPAs) across both Bun (TypeScript) and Python (Camoufox) engines.

---

## 1. When to Use TempMail vs Google OAuth

| Strategy | When to use | Primary targets |
|---|---|---|
| **Google OAuth** (`@ifqy/google-oauth` / `packages.camoufox_core`) | Site mandates Google SSO, presents impossible Turnstile on email forms, or restricts disposable email domains | CBDG, Crusoe, FastRouter, Webshare, TokenHarbor (Google mode) |
| **TempMail Automation** (`TempMailClient`) | Site allows direct email signup with verification links, magic links, or 6-digit OTP codes | TokenHarbor (TempMail mode), GroqCloud, platforms with email-only activation |

---

## 2. TempMail-Pro API Reference

- **Base URL**: `https://temp-postservice.verifwebsitepro.workers.dev`
- **Auth Header**: `x-api-key: <API_KEY>` (Default: `anjingmemekkontol`)
- **Supported Domains**: `@ifqy.net`, `@meongtopup.my.id`, `@huzt.my.id`

### Core Endpoints

1. **Create Email**
   - `POST /api/email/create`
   - Request Body: `{"domain": "ifqy.net", "username": "<optional>"}`
   - Response:
     ```json
     {
       "status": "ok",
       "code": 201,
       "msg": "Email berhasil dibuat",
       "data": {
         "email": "username@ifqy.net",
         "username": "username",
         "domain": "ifqy.net"
       }
     }
     ```

2. **Check Inbox**
   - `GET /api/email/inbox?address=<EMAIL>`
   - Response:
     ```json
     {
       "status": "ok",
       "code": 200,
       "msg": "Inbox tersedia",
       "address": "username@ifqy.net",
       "mails": [
         {
           "id": "username@ifqy.net-xxx",
           "sender": "verify@tokenharbor.ai",
           "subject": "Verify your email to start using the Token Harbor API",
           "content-plain": "Click link: https://tokenharbor.ai/verify-email?token=...",
           "content-html": "<p>...</p>"
         }
       ]
     }
     ```

3. **Delete Email**
   - `DELETE /api/email/delete?address=<EMAIL>`

---

## 3. Supported Registration & Verification Patterns

### Pattern 0: Direct Registration without Email Verification (e.g. Composite Lucidity)
- **Flow**: Target site does NOT mandate email link or OTP confirmation. Registering with username, TempMail email, password, and solving Turnstile creates the session immediately.
- **Action**:
  1. Call `temp_mail.create_email(domain="ifqy.net")` to obtain valid disposable address.
  2. Fill form (`#reg-username`, `#reg-email`, `#reg-password`, `#reg-confirm`).
  3. Solve Cloudflare Turnstile via Camoufox mouse click (`resolve_turnstile_if_present`).
  4. Submit form and wait for redirect directly to `/dashboard.html` or `/apikeys.html`.
  5. **No inbox polling needed**. Proceed straight to API key creation.

### Pattern A: Direct Activation Link (e.g. TokenHarbor)
- **Email Content**: Contains `<a href="https://tokenharbor.ai/verify-email?token=...">`
- **Regex**: `r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+"`
- **Action**: Poll inbox (`client.wait_for_verification_link`), navigate browser directly to the link, verify dashboard renders.

### Pattern B: Magic Link / Stytch Redirect (e.g. GroqCloud)
- **Email Content**: Contains `<a href="https://stytch.com/v1/magic_links/redirect?public_token=...&token=...">`
- **Regex**: `r"https?://stytch\.com/v1/magic_links/redirect\?[^\s\"'<>]+"`
- **Action**: Navigate browser to the magic link. Stytch handles authentication and redirects back to the console (`console.groq.com`).
- **Post-Magic-Link Step**: Check for organization creation loading state or auto-redirect to `/home` before navigating to API keys.

### Pattern C: 6-Digit OTP Verification Code (e.g. OpenRouter Reverification, FastRouter)
- **Email Content**: Contains a 6-digit confirmation PIN (e.g. `Your verification code is 492014`).
- **Regex**: `r"\b\d{6}\b"`
- **Action**:
  1. Poll inbox for latest mail matching sender or subject (`client.get_inbox(email)`).
  2. Extract 6 digits using `re.search(r"\b(\d{6})\b", content)`.
  3. Locate OTP input (`input[data-input-otp="true"]` or `input[autocomplete="one-time-code"]`).
  4. Fill with `human_type` or single-char inputs and submit.

---

## 4. Reusable Client Usage

### Usecase 1: Direct Registration Only (Composite Lucidity)
```python
from packages.camoufox_core import TempMailClient

temp_mail = TempMailClient(
    base_url="https://temp-postservice.verifwebsitepro.workers.dev",
    default_domain="ifqy.net",
    api_key="anjingmemekkontol",
)
acc = temp_mail.create_email(domain="ifqy.net")
email = acc["email"]

# Directly fill email in signup form and solve Turnstile:
await page.locator("#reg-email").fill(email)
# Submit form -> redirects to /dashboard.html (no link polling needed)
```

### Usecase 2: Polling for Verification Link (TokenHarbor)
```python
verify_url = await temp_mail.wait_for_verification_link(
    email=email,
    filter_sender="tokenharbor",
    link_regex=r"https?://tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+",
    timeout_sec=65,
)
await page.goto(verify_url)
```

### Usecase 3: Polling for 6-Digit OTP Code (OpenRouter / FastRouter)
```python
import re

async def poll_otp_code(temp_mail: TempMailClient, email: str, timeout_sec: int = 60) -> str:
    start_t = time.time()
    while time.time() - start_t < timeout_sec:
        inbox = await asyncio.to_thread(temp_mail.get_inbox, email)
        mails = inbox.get("mails", [])
        for mail in mails:
            body = (mail.get("content-plain") or "") + " " + (mail.get("content-html") or "")
            m = re.search(r"\b(\d{6})\b", body)
            if m:
                return m.group(1)
        await asyncio.sleep(3.0)
    raise TimeoutError(f"OTP code did not arrive for {email} within {timeout_sec}s")
```

---

## 5. Clean Unescaping & Google URL Redirect Handling

When extracting verification URLs from HTML emails or Gmail forwarded content:
1. Always run `html.unescape()` to remove `&amp;` and numeric entities.
2. If the URL is wrapped in Google's tracking redirect (`https://www.google.com/url?q=...`), extract the underlying URL:
```python
import html
from urllib.parse import urlparse, parse_qs

raw_url = html.unescape(matched_str)
if "google.com/url" in raw_url:
    parsed = urlparse(raw_url)
    qs = parse_qs(parsed.query)
    clean_url = qs.get("q", [raw_url])[0]
else:
    clean_url = raw_url
```
