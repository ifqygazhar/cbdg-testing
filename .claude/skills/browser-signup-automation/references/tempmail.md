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

## 3. Supported Verification Patterns

### Pattern A: Direct Activation Link (e.g. TokenHarbor)
- **Email Content**: Contains `<a href="https://tokenharbor.ai/verify-email?token=...">`
- **Regex**: `r"https?://(?:www\.)?tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+"`
- **Action**: Navigate browser directly to the link. Verify dashboard renders.

### Pattern B: Magic Link / Stytch Redirect (e.g. GroqCloud)
- **Email Content**: Contains `<a href="https://stytch.com/v1/magic_links/redirect?public_token=...&token=...">`
- **Regex**: `r"https?://stytch\.com/v1/magic_links/redirect\?[^\s\"'<>]+"`
- **Action**: Navigate browser to the magic link. Stytch handles authentication and redirects back to the console (`console.groq.com`).
- **Post-Magic-Link Step**: Check for organization creation loading state or auto-redirect to `/home` before navigating to API keys.

### Pattern C: 6-Digit OTP Verification Code
- **Email Content**: Contains a 6-digit confirmation PIN (e.g. `Your verification code is 492014`).
- **Regex**: `r"\b\d{6}\b"`
- **Action**: Locate the PIN input boxes or single numeric input, fill with `human_type`, and submit.

---

## 4. Reusable Client Usage

### Bun / TypeScript
```ts
import { TempMailClient } from "@ifqy/google-oauth";

const client = new TempMailClient({
  apiKey: process.env.TEMPMAIL_API_KEY ?? "anjingmemekkontol",
  defaultDomain: "ifqy.net",
});

const account = await client.createEmail();
// 1. Submit email to signup form...
// 2. Poll for verification / magic link
const verifyUrl = await client.waitForVerificationLink(account.email, {
  filterSender: "groq", // or "tokenharbor"
  timeoutMs: 65_000,
});
await page.goto(verifyUrl);
```

### Python / Camoufox
```python
from packages.camoufox_core import TempMailClient

client = TempMailClient(default_domain="ifqy.net")
account = client.create_email()
email = account["email"]

# 1. Submit email in Camoufox page...
# 2. Poll for link
verify_url = await client.wait_for_verification_link(
    email=email,
    filter_sender="tokenharbor",
    link_regex=r"https?://tokenharbor\.ai/verify-email\?token=[A-Za-z0-9_\-\.%]+",
    timeout_sec=65,
)
await page.goto(verify_url)
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
