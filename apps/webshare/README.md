# apps/webshare — Webshare Free-Proxy Signup Automation

Bun + Puppeteer (via `@ifqy/google-oauth`) yang mengotomasi:

**/register (Google OAuth pakai GSuite) → dashboard → proxy list → simpan 10 proxy
gratis per akun ke `proxy.txt`**

## Seed files (satu per baris, `#` = komentar)

- `gsuite.txt` → `email:password`
- `signup-proxy.txt` → **opsional**, proxy untuk menjalankan signup-nya.
  Sengaja bukan `proxy.txt`. Memakai proxy hasil panen untuk mendaftar akun
  berikutnya menautkan semua akun itu ke satu identitas di mata risk control
  Webshare.

## Menjalankan

```bash
bun run webshare                          # headed (default)
bun run webshare -- --fast --delay 60     # cepat tapi tetap manusiawi
bun run webshare -- -w 2                  # 2 akun paralel
bun run webshare -- --dry-run             # validasi config + seed, tanpa browser
bun run webshare -- --retry-failed        # ulangi akun di akun-failed-webshare.txt
```

## Dua hal yang menentukan desain flow ini

**1. Tombol "Sign up with Google" tidak bisa diklik dari otomasi.**
Halaman register memakai Google Identity Services dengan `ux_mode: "popup"`.
Di browser otomasi, klik tombol itu tidak membuka apa pun dan tidak melempar
error, jadi terlihat seperti hang. Modul yang sama (`assets/WithGoogleAuth-*.js`)
punya jalur lain:

```js
const m = search.start_google_login_flow === "";
ux_mode: m ? "redirect" : "popup"   // dan useEffect langsung menjalankannya
```

Jadi flow memakai `?start_google_login_flow=` dan halaman itu mengarahkan
dirinya sendiri ke `accounts.google.com` sebagai navigasi top-level. Perhatikan
tanda `=` di akhir. Tanpa itu nilainya bukan string kosong dan aplikasi diam-diam
kembali ke mode popup. Tombolnya tetap dipakai sebagai fallback saja.

**2. Daftar proxy diambil dari API aplikasinya sendiri, bukan dari tabel.**
Halaman proxy ada di `/$planId/proxy/list`, dan `planId` hanya ada setelah akun
punya plan. Flow membaca `planId` dari `href` link sidebar, lalu:

- menyimak respons `proxy.webshare.io/api/**` yang diminta aplikasi sendiri, dan
- mengambil header `Authorization` dari panggilan API mana pun, lalu meminta
  ulang `proxy/list/?mode=direct&page_size=100` dari Node.

Token itu hanya hidup di memori aplikasi, jadi menyalinnya dari request yang
sudah terotorisasi lebih andal daripada menebak cara loginnya. Permintaan ulang
juga memastikan kita dapat 10 IP langsung, bukan satu endpoint rotating yang
mungkin sedang ditampilkan UI.

## Hasil

- `proxy.txt` → `http://user:pass@host:port` per baris, langsung terbaca oleh
  `loadProxies` di app cbdg dan crusoe. Baris yang sudah ada tidak diduplikasi,
  dan isi manual di file itu tidak disentuh.
- `akun-result-webshare.txt` → `email|timestamp|jumlah proxy`
- `akun-failed-webshare.txt` → `email|timestamp|alasan`
- `screenshots-webshare/` → screenshot dan dump HTML saat gagal

Set `WEBSHARE_PROXY_FORMAT=webshare` kalau mau format `host:port:user:pass`.

## Guardrail (sama seperti cbdg dan crusoe)

- **1 akun = 1 fingerprint** — browser di-launch ulang dan SELALU ditutup.
- **Resume/skip** — akun di `akun-result-webshare.txt` selalu dilewati; yang
  gagal dilewati kecuali `--retry-failed`.
- **`ACCOUNT_RESTRICTED` tidak pernah di-retry.**
- **Crash-safe** — progres tiap state di `state-webshare.jsonl`.

## Config (env)

`WORKERS`, `HEADLESS`, `RETRY_FAILED`, `INTER_ACCOUNT_DELAY_SEC`, `PACE`,
`SEED_GSUITE`, `WEBSHARE_SEED_PROXY`, `DASHBOARD_TIMEOUT_SEC` (90),
`PROXY_LIST_TIMEOUT_SEC` (60), `WEBSHARE_PROXY_FORMAT`, `WEBSHARE_PROXY_FILE`,
`WEBSHARE_STATE_FILE`, `WEBSHARE_RESULT_SUCCESS_FILE`,
`WEBSHARE_RESULT_FAILED_FILE`, `WEBSHARE_SCREENSHOT_DIR`.

## Testing

```bash
bun run test:webshare-units    # config/selectors/format/store
bun run test:webshare-queue    # antrean (mock runner)
```

Tes selektor dicocokkan ke `webshare_dataset/signup.html` dan
`webshare_dataset/proxy-data.html`, jadi perubahan layout gagal di tes, bukan
saat run.

> Catatan: mengotomasi pembuatan akun massal berpotensi melanggar ToS. Gunakan
> dengan risiko sendiri.
