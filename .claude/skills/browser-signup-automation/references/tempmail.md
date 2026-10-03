# TempMail Integration & Email Verification Guide

This reference documents the pattern for using temporary disposable email addresses (TempMail-Pro API) in automated browser registration flows (e.g. TokenHarbor, custom Next.js apps) across both Bun (TypeScript) and Python (Camoufox) engines.

---

## 1. When to Use TempMail vs Google OAuth

| Strategy | When to use | Primary targets |
|---|---|---|
| **Google OAuth** (`@ifqy/google-oauth`) | Site mandates Google SSO or presents Turnstile on email forms | CBDG, Crusoe, FastRouter, Webshare |
| **TempMail Automation** (`TempMailClient`) | Site allows direct email/password registration with email verification link or code | TokenHarbor, platforms with email-only activation |

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

## 3. Recommended Flow Pattern

1. **Email Provisioning**:
   - Call `client.createEmail()` at the start of an account run to generate a fresh inbox.
   - Use default secure password (e.g. `torabikA1###########` or per-account generated password).

2. **Registration Form Fill**:
   - Navigate to signup page (e.g. `https://tokenharbor.ai/login?mode=signup`).
   - Dismiss cookie/analytics modals if present.
   - Fill email, password, and submit.
   - Wait for redirection to dashboard or confirmation screen.

3. **Trigger Verification**:
   - If the platform requires explicitly clicking "Verify email" on dashboard (like TokenHarbor), click the verification banner.
   - Also handle post-signup consent modals (e.g. "Enable free models").

4. **Inbox Polling & Link Extraction**:
   - Poll inbox every 2–3s for up to 60–90s.
   - Match email by sender (`verify@tokenharbor.ai`) or subject.
   - Extract verification URL via regex:
     ```ts
     const link = await tempMail.waitForVerificationLink(email, {
       filterSender: "tokenharbor",
       linkRegex: /https:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9_\-]+/,
     });
     ```

5. **Email Activation**:
   - Navigate page to the extracted link (`await page.goto(link)`).
   - Verify activation success indicators.

6. **Post-Activation Steps (API Key Creation)**:
   - Navigate to API Keys section (`/dashboard/api-keys`).
   - Click `+ New key`, input label, and submit `Create key`.
   - Extract raw API key from `<code ...>` element via regex (`thk_(live_)?[A-Za-z0-9_-]{20,}`).
   - Append to result files (`apikey-tokenharbor.txt`, `akun-result-tokenharbor.txt`).

7. **Cleanup**:
   - Optionally call `client.deleteEmail(email)` after successful completion to keep inbox pool clean.

---

## 4. Reusable Client Usage

### Bun / TypeScript
```ts
import { TempMailClient } from "@ifqy/google-oauth";

const client = new TempMailClient({
  apiKey: process.env.TEMPMAIL_API_KEY ?? "anjingmemekkontol",
});

const account = await client.createEmail();
// ... complete browser signup ...
const verifyUrl = await client.waitForVerificationLink(account.email);
await page.goto(verifyUrl);
```

### Python / Camoufox
```python
from packages.camoufox_core import TempMailClient

client = TempMailClient()
account = client.create_email()
# ... complete browser signup ...
verify_url = await client.wait_for_verification_link(account["email"])
await page.goto(verify_url)
```
