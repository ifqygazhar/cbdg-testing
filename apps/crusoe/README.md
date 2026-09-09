# apps/crusoe — Crusoe AI Foundry Signup Automation ($5 bonus)

Bun + Puppeteer (via `@ifqy/google-oauth`) workspace app yang mengotomasi:

**/request-foundry (bonus $5) → Sign up with Google (GSuite OAuth) → complete-signup
(Name/Company + consent) → dashboard Welcome → Get API Key → flyout (nama + Create)
→ simpan key ke `apikey.txt`**

> Catatan alur: setelah signup, aplikasi mendarat di dashboard Foundry, bukan
> form onboarding. Tombol `Create` baru ada di dalam flyout yang dibuka tombol
> **Get API Key**, jadi flow harus membuka flyout itu dulu.

## Seed files (satu per baris, `#` = komentar)

- `gsuite.txt` → `email:password`
- `proxy.txt` → `host:port` atau `scheme://user:pass@host:port` (**opsional** — tanpa proxy semua akun berbagi 1 IP)

## Menjalankan

```bash
bun run crusoe                      # headed (default)
bun run crusoe -- --headless        # headless penuh (gagal cepat saat captcha)
bun run crusoe -- -w 2              # 2 akun paralel
bun run crusoe -- --dry-run         # validasi config + seed, tanpa browser
bun run crusoe -- --retry-failed    # ulangi akun di akun-failed-crusoe.txt
bun run crusoe -- --delay 60        # jeda antar akun (risk-control spacing)
bun run crusoe -- --fast --delay 60 # cepat tapi tetap manusiawi
bun run crusoe -- --careful         # paling pelan, untuk risk engine galak
```

### Profil kecepatan (`--fast` / `--pace`)

| profil | ketikan per karakter | jeda antar aksi | tunggu halaman siap |
| --- | --- | --- | --- |
| `fast` | 18-55 ms | 120-380 ms | maks 6 s |
| `human` (default) | 30-90 ms | 300-800 ms | maks 15 s |
| `careful` | 60-150 ms | 700-1800 ms | maks 30 s |

Yang dipangkas hanya waktu menunggu sesuatu yang sebenarnya sudah selesai.
Mengetik, gerak mouse, dan jeda antar aksi tetap acak dan tetap dalam rentang
manusia, jadi `--fast` bukan mode robot. Penghemat terbesar ada di dalam
library: alur OAuth dulu menunggu jaringan sepi sampai 30 detik di halaman
Google yang memang tidak pernah sepi, sekarang ia menunggu kolom email muncul.

`--fast` **tidak** mengurangi `--delay`. Jeda antar akun adalah sinyal yang
dilihat risk control, jadi tetap pakai `--delay` walau memakai `--fast`.

## Guardrail (warisan dari cbdg)

- **1 akun = 1 fingerprint** — browser di-launch ulang dan SELALU ditutup per akun.
- **Resume/skip** — akun yang sudah tercatat di `akun-result-crusoe.txt` selalu dilewati;
  akun di `akun-failed-crusoe.txt` atau `state-crusoe.jsonl` berstatus `FAILED` juga dilewati
  kecuali `--retry-failed`.
- **Akun `ACCOUNT_RESTRICTED` tidak pernah di-retry** — ban risk-control permanen.
- **Tanpa proxy multi-akun → warning** — sinyal velocity terkuat untuk risk-control.
- **Crash-safe** — progres tiap state di `state-crusoe.jsonl`.
- **Tahan SPA crash** — console Crusoe bisa jatuh ke error boundary
  ("Unexpected Application Error!"). Flow mendeteksi halaman error itu, lalu
  membuka ulang `/request-foundry` (maks 3x) sebelum menyerah, dan tidak pernah
  mengklik link "Login" di landing (klik itu memindahkan kita dari halaman
  signup).
- **Header `Accept` tidak dipaksa** — tombol Google baru berfungsi setelah
  aplikasi menerima flow Ory Kratos dalam bentuk JSON. Dulu launcher memaksa
  `Accept: text/html…` di semua request, Kratos membalas halaman HTML, dan
  `flow.ui.nodes` meledak begitu tombol diklik. Detailnya di
  `packages/google-oauth/src/browser.ts`.

## Hasil

- `apikey.txt` → 1 API key per baris (deliverable utama). Key asli ~82 karakter
  dan bisa mengandung `/` serta `.`, jadi jangan dipersempit ke base64url saja.
  Kalau key gagal dibaca, halaman ikut disimpan sebagai
  `screenshots-crusoe/no-apikey-<email>.html` supaya key masih bisa diambil manual.
- `akun-result-crusoe.txt` → `email|timestamp|apikey`
- `akun-failed-crusoe.txt` → `email|timestamp|alasan`
- `screenshots-crusoe/` → screenshot saat error

## Config (env, prefix `CRUSOE_` untuk output agar tidak bentrok dengan cbdg)

`WORKERS`, `HEADLESS`, `RETRY_FAILED`, `INTER_ACCOUNT_DELAY_SEC`, `SEED_GSUITE`,
`SEED_PROXY`, `SIGNUP_FORM_TIMEOUT_SEC` (45), `API_KEY_TIMEOUT_SEC` (180),
`CREDITS_TIMEOUT_SEC` (30), `CRUSOE_STATE_FILE`, `CRUSOE_RESULT_SUCCESS_FILE`,
`CRUSOE_RESULT_FAILED_FILE`, `CRUSOE_APIKEY_FILE`, `CRUSOE_SCREENSHOT_DIR`
(detail lengkap di `.env.example`).

## Testing

```bash
bun run test:crusoe-units    # config/loaders/selectors/store
bun run test:crusoe-queue    # antrean (mock runner)
```

> Catatan: mengotomasi pembuatan akun massal berpotensi melanggar ToS. Gunakan dengan risiko sendiri.