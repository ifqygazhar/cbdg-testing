# cbdg — CodeBuddy $200-Credit Signup Automation

Bun + Puppeteer (stealth) workspace yang mengotomasi flow:
**/pricing (bonus 200 credit) → Google OAuth (GSuite) → complete registration (region) →
payment profile → HarvestSharp/Midas link VCC (tahan 3DS manual) → aktivasi trial 7 hari →
verifikasi kredit 500/250.**

Terdiri dari dua paket:

| Paket | Fungsi |
|---|---|
| `packages/google-oauth` | **Library reusable** `@ifqy/google-oauth` — port battle-tested dari `cline-regist/cline/google-auth.js`. Untuk projek lain yang butuh "sign in with Google" otomatis, tinggal panggil library ini. |
| `apps/cbdg` | Aplikasi flow CodeBuddy yang memakai library di atas. |

## Setup

```bash
bun install
cp .env.example .env
```

Browser dipakai dari instalasi lokal (Edge/Chrome/Chromium terdeteksi otomatis — tidak ada unduhan Chromium).

## Isi seed files (satu per baris, `#` = komentar)

- `gsuite.txt` → `email:password`
- `vcc.txt` → `card number | exp date | cvv` (MM/YY atau MM/YYYY)
- `proxy.txt` → `host:port` atau `scheme://user:pass@host:port` (**opsional** — tanpa proxy berjalan direct)

## Menu interaktif

```bash
bun run start
```

Pilih app, mode, pakai proxy atau tidak, dan kecepatannya lewat menu. Sebelum
jalan ia menampilkan ringkasan, peringatan yang relevan, dan perintah persisnya
supaya lain kali bisa langsung diketik. Detail di `docs/RUNNING.md` bagian 4.

## Menjalankan di VPS

Satu bundel berisi ketiga app plus library-nya, tanpa source apa pun:

```bash
bun run build:dist        # dist/runner.js (~94 KB), ikut di-commit

# di VPS: repo private tetap bisa diambil dengan token
RAW=https://raw.githubusercontent.com/ifqygazhar/cbdg-testing/main
curl -fsSL -H "Authorization: Bearer <token>" $RAW/scripts/vps-bootstrap.sh |
  bash -s -- --from $RAW/dist --token <token> --ephemeral
```

Di VPS, jalankan lewat wrapper supaya laptop boleh dimatikan:

```bash
cd ~/runner
./run.sh start webshare --headless --fast --delay 60
./run.sh logs      # ikuti     ./run.sh status     ./run.sh stop
```

`curl | bash` tidak menyembunyikan apa pun dari pemilik VPS, dan `gsuite.txt`
berisi password Google yang lebih berharga daripada kodenya. Detailnya di
`docs/RUNNING.md` bagian 14.

## Aplikasi di repo ini

| app | perintah | hasil |
| --- | --- | --- |
| cbdg | `bun run cbdg` | kredit $200 CodeBuddy |
| crusoe | `bun run crusoe` | bonus $5 + API key ke `apikey.txt` |
| webshare | `bun run webshare` | 10 proxy gratis per akun ke `proxy.txt` |

Plus satu tool: `bun run proxy-check` menguji proxy hasil panen dan menulis yang
hidup ke `proxy-live.txt`.

```bash
bun run webshare       # 1. panen proxy      → proxy.txt
bun run proxy-check    # 2. saring yang mati → proxy-live.txt
bun run crusoe         # 3. pakai            ← proxy-live.txt
```

`cbdg` dan `crusoe` membaca `proxy-live.txt` kalau ada, dan jatuh ke `proxy.txt`
kalau belum pernah dicek. Pilih **dengan proxy** di menu, atau tambahkan
`--with-proxy` / `--no-proxy`.

Ketiganya memakai `@ifqy/google-oauth` yang sama dan pola guardrail yang sama.
Detail per app ada di `apps/<nama>/README.md`.

## Menjalankan

```bash
bun run cbdg                      # headed (default) — bisa selesaikan 3DS/captcha manual
bun run cbdg -- --headless        # headless penuh
bun run cbdg -- -w 2              # 2 akun paralel
bun run cbdg -- --region SG       # override region
bun run cbdg -- --dry-run         # validasi config + seed, tanpa browser
bun run cbdg -- --retry-failed    # ulangi akun yang ada di akun-failed.txt
bun run cbdg -- --signup-only     # berhenti setelah daftar, tanpa VCC
bun run cbdg -- --fast --delay 60 # cepat tapi tetap manusiawi
```

### Sampai mana satu akun dijalankan (`--signup-only` / `--full`)

| mode | jalannya | butuh `vcc.txt` | hasil |
| --- | --- | --- | --- |
| `--signup-only` | pricing → OAuth Google → complete register → cek kredit | tidak | akun jadi + kredit new-user |
| `--full` (default) | lanjut ke payment profile → isi kartu → 3DS → trial | ya | tambah kredit trial |

`--signup-only` berhenti tepat setelah submit registrasi, karena kredit new-user
diberikan oleh registrasinya sendiri, bukan oleh kartu. Di mode ini `vcc.txt`
boleh kosong dan antrean tidak lagi berhenti karena tidak ada kartu. Langkah
terakhirnya membuka halaman plans-usage dan mengecek kreditnya. Kalau tidak
terkonfirmasi, akun tetap dihitung berhasil dengan catatan
`welcome credit unconfirmed`, bukan dibuang, karena akunnya sudah jadi.

### Profil kecepatan (`--fast` / `--careful` / `--pace`)

Sama seperti crusoe dan webshare. Yang dipangkas hanya waktu menunggu sesuatu
yang sudah selesai. Ketikan, gerak mouse, dan jeda antar aksi tetap acak dalam
rentang manusia. `--fast` **tidak** mengurangi `--delay`, dan jeda antar akun
itulah yang dilihat risk control.

## Cara kerja / guardrail

- **1 akun = 1 fingerprint.** Setiap akun dijalankan di browser launch baru (stealth + viewport jitter) dan browser **selalu ditutup** setelah akun selesai/gagal — akun berikutnya dapat fingerprint segar.
- **3DS manual:** saat halaman Midas masuk mode verifikasi, bot berhenti dan menunggu (default 180 dtk, `WAIT_3DS_TIMEOUT_SEC`), lalu lanjut otomatis saat layar sukses muncul.
- **Resume / skip (default):** saat re-run, akun yang sudah tercatat di `akun-result.txt` **selalu** dilewati; akun di `akun-failed.txt` atau `state.jsonl` berstatus `FAILED` juga dilewati — kecuali lewat `--retry-failed`.
- **Crash-safe:** progres tiap state tersimpan di `state.jsonl`; sumber kebenaran hasil = `akun-result.txt` / `akun-failed.txt` (email = field pertama, mudah di-parse ulang).
- **Isolasi queue:** satu akun meledak tidak mematikan antrean.
- **Proxy** diparse dan tersedia (round-robin per akun) tapi opsional. **Tanpa proxy, semua akun berbagi 1 IP** — sinyal velocity paling kuat untuk risk-control; queue menampilkan warning saat berjalan multi-akun tanpa proxy.
- **Spacing antar akun:** `INTER_ACCOUNT_DELAY_SEC` (atau `--delay 120`) — jeda minimum per worker sebelum akun berikutnya (+ jitter acak 0–50%). Mitigasi risk-control.
- **Akun `ACCOUNT_RESTRICTED` tidak pernah di-retry** — ban risk-control bersifat permanen; `--retry-failed` otomatis melewatinya.

## Hasil

- `akun-result.txt` → `email|timestamp|region` (sukses — trial aktif + kredit terverifikasi)
- `akun-failed.txt` → `email|timestamp|alasan` (gagal — untuk `--retry-failed`)
- `state.jsonl` → record progres per state (resume-safe)
- `screenshots/` → screenshot saat error/captcha (via library)

## Testing

```bash
bun run test          # semua suite (isolasi per-proses untuk mock)
bun run typecheck     # tsc --noEmit
```

Cakupan test (88 test):
- **library** — utils, config, URL detection; **integrasi browser asli** (Edge): stealth launch, `clickByText` (termasuk piercing shadow-DOM), `fillInput` native setter (aman untuk React/Vue), timeout semantics, close idempotent.
- **app** — config/env/CLI args, loaders (CRLF, komentar, format), JsonlStore (corrupt line, replay, terminal), ResultWriter, engine integrity (registry vs state machine), **validasi selector terhadap `dataset_target/` HTML asli**.
- **runner** (mock engine + browser) — happy path penuh, jalur gagal, dan invarian *"browser selalu tertutup"* + fingerprint unik per akun.
- **queue** (mock runner) — pairing kartu siklik, skip akun terminal, abort tanpa seed, isolasi error, batas concurrency worker-pool.

## Struktur

```
packages/google-oauth/     # library reusable (@ifqy/google-oauth)
  src/
    googleAuth.ts           # performGoogleOAuth + semua helper OAuth
    browser.ts              # launch stealth + deteksi browser lokal + proxy
    dom.ts                  # clickByText (shadow-DOM piercing), fillInput, dll
    antiDetect.ts           # simulasi manusia + viewport jitter
    utils.ts / config.ts / screenshot.ts
apps/crusoe/                # signup Crusoe AI Foundry → bonus $5 + API key
apps/webshare/              # signup Webshare via Google → panen proxy gratis
apps/cbdg/                  # aplikasi flow
  src/
    cli.ts                  # entrypoint + parseArgs
    config.ts / loaders.ts / store.ts / log.ts
    runner.ts               # 1 akun: fingerprint → browser → flow → close
    queue.ts                # worker-pool scheduling
    flow/
      engine.ts             # state machine + FlowCtx
      steps.ts              # s01 pricing … s07 trial+verify
      selectors.ts          # semua selector di satu tempat
dataset_target/             # HTML yang kamu kumpulkan (dipakai test validasi)
crusoe_ai_dataset/          # idem untuk apps/crusoe
webshare_dataset/           # idem untuk apps/webshare
.claude/skills/browser-signup-automation/   # playbook + katalog kegagalan
docs/plans/                 # rencana implementasi
```

> **Catatan:** mengotomasi pembuatan akun massal + pendaftaran kartu virtual ke layanan pihak ketiga berpotensi melanggar ToS layanan terkait. Gunakan dengan risiko sendiri.
