# Panduan Menjalankan Proyek cbdg

Dokumentasi operasional untuk menjalankan tiga aplikasi di dalam satu Bun workspace,
dengan library bersama `@ifqy/google-oauth` (`packages/google-oauth`):

| App | Perintah | Hasil |
|---|---|---|
| `apps/cbdg` | `bun run cbdg` | kredit CodeBuddy (signup saja, atau lanjut VCC + trial) |
| `apps/crusoe` | `bun run crusoe` | bonus $5 Crusoe + API key ke `apikey.txt` |
| `apps/webshare` | `bun run webshare` | 10 proxy gratis per akun ke `proxy.txt` |
| `scripts/proxy-check.ts` | `bun run proxy-check` | saring proxy hidup ke `proxy-live.txt` |

Paling gampang lewat launcher: `bun run start` (lihat bagian 4).

> ⚠️ **Disclaimer:** mengotomasi pembuatan akun massal + pendaftaran kartu virtual ke
> layanan pihak ketiga berpotensi melanggar ToS layanan terkait. Gunakan dengan risiko sendiri.

---

## 1. Prasyarat

| Requirement | Detail |
|---|---|
| **Bun** ≥ 1.x | Runtime utama. Proyek ini **tidak memakai Node** — semua script dijalankan via `bun run`. |
| **Browser lokal** | Salah satu dari: **Microsoft Edge**, **Google Chrome**, atau **Chromium** — terdeteksi otomatis, **tidak ada unduhan Chromium** oleh Puppeteer. |
| OS | Windows / Linux / macOS (path browser dideteksi per-platform, lihat `packages/google-oauth/src/browser.ts`). |

Cek versi Bun:

```bash
bun --version   # minimal 1.x (dikembangkan di 1.3.x)
```

## 2. Setup Pertama

```bash
# 1. Install dependencies workspace
bun install

# 2. Buat file .env dari template (ada contoh lengkap di .env.example)
cp .env.example .env
```

Jika mau menjalankan **dua aplikasi sekaligus** dengan konfigurasi berbeda,
cukup jalankan dari direktori berbeda atau set env var eksplisit per perintah
(CLI flag selalu menang atas file `.env`).

## 3. Seed Files (Data Masukan)

Semua seed file dibaca **satu baris per entri**, baris kosong diabaikan,
dan baris yang diawali `#` dianggap komentar. File yang tidak ada = dianggap kosong (tidak error).

| File | Format | Wajib? |
|---|---|---|
| `gsuite.txt` | `email:password` per baris | ✅ wajib untuk ketiga app |
| `vcc.txt` | `card number \| exp date \| cvv` — exp `MM/YY` atau `MM/YYYY`, cvv 3–4 digit | ✅ hanya untuk `cbdg --full` |
| `proxy.txt` | `host:port` atau `scheme://user:pass@host:port` | ❌ opsional. **Ditulis oleh `webshare`**, jadi masukan `proxy-check`. |
| `proxy-live.txt` | sama, urut dari tercepat | 🔁 **dihasilkan** `proxy-check`. Inilah yang dibaca `cbdg` dan `crusoe`. |
| `signup-proxy.txt` | sama seperti `proxy.txt` | ❌ opsional, khusus proxy untuk signup `webshare` |

Contoh:

```text
# gsuite.txt
user.one@gmail.com:S3cure!Pass123
user.two@gmail.com:Another!Pass456

# vcc.txt
4111111111111111 | 12/26 | 123
5500000000000004 | 01/28 | 4567

# proxy.txt
http://user:pass@1.2.3.4:8080
5.6.7.8:3128
```

> **Catatan proxy:** jika `proxy.txt` kosong atau tidak ada, semua akun berbagi 1 IP yang sama.
> Menjalankan multi-akun tanpa proxy memunculkan warning di log (sinyal velocity kuat untuk risk-control).
>
> Alur yang dimaksud: `webshare` mengisi `proxy.txt`, `proxy-check` menyaringnya jadi
> `proxy-live.txt`, lalu `cbdg` atau `crusoe` dijalankan dengan pilihan **dengan proxy**.
> `signup-proxy.txt` sengaja file terpisah supaya signup webshare berikutnya tidak lewat
> proxy hasil panennya sendiri.

## 4. Cara Cepat: Launcher Interaktif

```bash
bun run start
```

Satu pintu untuk semua aplikasi. Urutan pertanyaannya:

1. **Mau jalankan yang mana** — webshare, cek proxy, crusoe, atau cbdg.
2. **Sampai mana** (khusus cbdg) — signup saja, atau full sampai VCC.
3. **Pakai proxy?** (cbdg dan crusoe) — dari `proxy.txt`, atau tanpa proxy.
4. **Kecepatan** — `human`, `fast`, atau `careful`.
5. Jeda antar akun, jumlah worker, retry akun gagal, headless, dan dry-run.

Sebelum menjalankan, launcher menampilkan ringkasan rencana, peringatan yang
relevan, dan **perintah persisnya**. Perintah itu bisa dipakai langsung lain kali
tanpa lewat menu, karena semua yang bisa dipilih di menu juga ada sebagai flag.

```text
Rencana
  app      cbdg
  mode     signup saja
  proxy    tanpa proxy
  pace     fast
  jeda     60s

Perhatian
  ! tanpa proxy: 34 akun berbagi satu IP, risk control gampang melihatnya.

perintah: bun run cbdg -- --headed --pace fast --signup-only --no-proxy --delay 60
```

Navigasi: `↑`/`↓` lalu Enter, atau tekan angkanya langsung. `Ctrl-C` batal.
Tiap pertanyaan punya default, jadi Enter terus juga aman.

Peringatan yang bisa muncul, semuanya pernah jadi masalah nyata:

- `gsuite.txt` kosong.
- mode full tapi `vcc.txt` kosong, jadi antrean akan berhenti.
- pilih pakai proxy padahal belum ada proxy sama sekali.
- `proxy.txt` terisi tapi belum pernah dicek, jadi `proxy-live.txt` masih kosong.
- tanpa proxy padahal banyak akun, jadi semuanya dari satu IP.
- jeda antar akun 0 detik.
- headless, yang berarti captcha dan 3DS tidak bisa diselesaikan manual.

## 5. Menjalankan Aplikasi `cbdg` (CodeBuddy)

Flow: **/pricing (bonus 200 credit) → Google OAuth (GSuite) → complete registration →
payment profile → link VCC (tahan 3DS manual) → aktivasi trial 7 hari → verifikasi kredit.**

```bash
# Jalankan default (headed — direkomendasikan)
bun run cbdg

# Headless penuh (tidak bisa intervensi 3DS/captcha)
bun run cbdg -- --headless

# 2 akun paralel
bun run cbdg -- -w 2

# Override region dua-huruf ISO
bun run cbdg -- --region SG

# Validasi config + seed saja, tanpa membuka browser
bun run cbdg -- --dry-run

# Ulangi akun yang tercatat gagal di akun-failed.txt
bun run cbdg -- --retry-failed

# Jeda minimum antar-akun (risk spacing), mis. 120 detik
bun run cbdg -- --delay 120

# Berhenti setelah daftar: ambil kredit new-user, tanpa submit VCC
bun run cbdg -- --signup-only

# Pace cepat tapi tetap manusiawi
bun run cbdg -- --fast --delay 60
```

### Sampai mana satu akun dijalankan

| Mode | Jalannya | Butuh `vcc.txt` | Hasil |
|---|---|---|---|
| `--signup-only` | pricing → OAuth Google → complete register → cek kredit | tidak | akun jadi + kredit new-user |
| `--full` (default) | lanjut ke payment profile → isi kartu → 3DS → trial | ya | tambah kredit trial |

`--signup-only` berhenti tepat setelah submit registrasi, karena kredit new-user
diberikan oleh registrasinya sendiri, bukan oleh kartu. `vcc.txt` boleh kosong
dan antrean tidak berhenti karena tidak ada kartu. Langkah terakhirnya membuka
plans-usage dan mengecek kredit. Kalau tidak terkonfirmasi, akun tetap dicatat
berhasil dengan catatan `welcome credit unconfirmed`, bukan dibuang, karena
akunnya sudah terlanjur jadi.

### Semua Flag CLI `cbdg`

| Flag | Deskripsi |
|---|---|
| `--headless` / `--headed` | Mode browser. Default: `headed`. Pakai `headed` agar bisa menyelesaikan 3DS/captcha manual. |
| `-w N` / `--workers N` | Jumlah worker paralel. Default dari env `WORKERS` (1). |
| `--region XX` | Override region (dua-huruf ISO). Default dari env `REGION`. |
| `--state FILE` | Path state file custom (default `state.jsonl`). |
| `--dry-run` | Parsing seed + validasi config **tanpa** meluncurkan browser. |
| `--retry-failed` / `--no-retry-failed` | Proses ulang akun di `akun-failed.txt`. Akun berstatus `ACCOUNT_RESTRICTED` **tidak pernah** di-retry (ban permanen). |
| `--delay SEC` | Set `INTER_ACCOUNT_DELAY_SEC` — jeda minimum antar akun per worker (+ jitter acak 0–50%). |
| `--signup-only` / `--no-vcc` | Berhenti setelah registrasi. Tidak pernah submit kartu, `vcc.txt` tidak diperlukan. |
| `--no-proxy` / `--with-proxy` | Pakai `proxy.txt` atau tidak. Env: `USE_PROXY`. Default pakai. |
| `--proxy FILE` | Pakai file proxy lain (default `proxy.txt`). Env: `SEED_PROXY`. |
| `--no-google-direct` | Kirim google sign-in lewat proxy juga. Default: langsung, supaya tidak kena captcha. Env: `GOOGLE_DIRECT`. |
| `--reuse-proxy` | Boleh satu alamat dipakai beberapa akun. Default: satu akun satu alamat, sisanya ditahan. Env: `PROXY_REUSE`. |
| `--full` | Default. Lanjut ke kartu, 3DS, dan trial. |
| `--mode signup\|full` | Bentuk eksplisit dari dua flag di atas. Env: `MODE`. |
| `--fast` / `--careful` / `--pace X` | Cadence UI: `fast`, `human` (default), `careful`. Env: `PACE`. Bukan pengganti `--delay`. |
| `-h` / `--help` | Cetak usage. |

> **Catatan syntax:** semua flag aplikasi harus ditulis **setelah `--`** karena
> `bun run cbdg` meneruskan argumen: `bun run cbdg -- --headless`.

## 6. Menjalankan Aplikasi `crusoe` (Crusoe AI)

Flow: **Request Foundry account → Sign up with Google → lengkapi profil (nama/perusahaan,
konsen) → buat API key → extract → simpan ke `apikey.txt`.**

```bash
# Default (headed, pace human)
bun run crusoe

# Headless penuh
bun run crusoe -- --headless

# Pace cepat (tanpa dead-waiting, ±1 mnt/akun bukan ±2)
bun run crusoe -- --fast

# Pace sangat hati-hati (untuk risk engine yang agresif)
bun run crusoe -- --careful

# Pace eksplisit
bun run crusoe -- --pace human

# Dry-run validasi
bun run crusoe -- --dry-run

# Retry akun gagal
bun run crusoe -- --retry-failed
```

### Semua Flag CLI `crusoe`

| Flag | Deskripsi |
|---|---|
| `--headless` / `--headed` | Mode browser. |
| `-w N` / `--workers N` | Worker paralel. |
| `--pace fast\|human\|careful` (atau `--fast` / `--careful`) | Kecepatan/naturalness UI. **Bukan** pengganti `--delay` — jeda antar akun tetap diatur `--delay`. |
| `--dry-run` | Validasi tanpa browser. |
| `--retry-failed` / `--no-retry-failed` | Proses ulang akun gagal. |
| `--delay SEC` | Jeda antar akun (knob utama risk-control). |
| `--no-proxy` / `--with-proxy` | Pakai `proxy.txt` atau tidak. Env: `USE_PROXY`. Default pakai. |
| `--proxy FILE` | Pakai file proxy lain (default `proxy.txt`). Env: `SEED_PROXY`. |
| `--no-google-direct` | Kirim google sign-in lewat proxy juga. Default: langsung, supaya tidak kena captcha. Env: `GOOGLE_DIRECT`. |
| `--reuse-proxy` | Boleh satu alamat dipakai beberapa akun. Default: satu akun satu alamat, sisanya ditahan. Env: `PROXY_REUSE`. |
| `--state FILE` | State file custom. |
| `-h` / `--help` | Usage. |

`crusoe` **memakai ulang** `SEED_GSUITE`, `SEED_PROXY`, `WORKERS`, `HEADLESS`,
`RETRY_FAILED`, `INTER_ACCOUNT_DELAY_SEC` dari `.env`, tapi output-nya di-namespace
`CRUSOE_*` sehingga dua aplikasi tidak saling menimpa state/hasil.

## 7. Menjalankan Aplikasi `webshare` (panen proxy gratis)

Flow: **`/register` → daftar lewat Google (GSuite) → dashboard → proxy list →
simpan proxy gratis ke `proxy.txt`.**

```bash
# Default (headed, pace human)
bun run webshare

# Cepat tapi tetap manusiawi, dengan jeda antar akun
bun run webshare -- --fast --delay 60

# Validasi config + seed saja
bun run webshare -- --dry-run

# Ulangi akun yang tercatat gagal
bun run webshare -- --retry-failed
```

### Semua Flag CLI `webshare`

| Flag | Deskripsi |
|---|---|
| `--headless` / `--headed` | Mode browser. |
| `-w N` / `--workers N` | Worker paralel. |
| `--pace fast\|human\|careful` (atau `--fast` / `--careful`) | Kecepatan UI. Bukan pengganti `--delay`. |
| `--dry-run` | Validasi tanpa browser. |
| `--retry-failed` / `--no-retry-failed` | Proses ulang akun gagal. |
| `--delay SEC` | Jeda antar akun. |
| `--state FILE` | State file custom. |
| `-h` / `--help` | Usage. |

Dua hal yang perlu diingat soal app ini:

- **Proxy untuk signup-nya sendiri** dibaca dari `signup-proxy.txt`
  (`WEBSHARE_SEED_PROXY`), **bukan** dari `proxy.txt` yang ia tulis. Mendaftar
  akun webshare baru lewat proxy hasil panen menautkan akun-akun itu ke satu
  identitas di mata risk control mereka.
- **Output-nya menumpuk** di `proxy.txt`, satu proxy per baris dalam bentuk
  `http://user:pass@host:port`, format yang langsung dibaca `loadProxies` di
  cbdg dan crusoe. Baris yang sudah ada tidak diduplikasi dan isi manual tidak
  disentuh. Set `WEBSHARE_PROXY_FORMAT=webshare` kalau mau
  `host:port:user:pass`.

`proxy.txt` inilah yang dipakai kalau di launcher kamu pilih **dengan proxy**
untuk cbdg atau crusoe.

## 8. Cek Proxy (`proxy-check`)

Proxy gratis webshare tidak semuanya hidup, dan proxy mati berarti akun terbuang.
Script ini menguji satu per satu lalu menulis yang hidup ke `proxy-live.txt`.

```bash
# default: proxy.txt → proxy-live.txt
bun run proxy-check

# lebih agresif, plus catat yang mati beserta alasannya
bun run proxy-check -- -c 20 --timeout 8 --dead proxy-dead.txt
```

Contoh keluaran:

```text
cek proxy 10 entri · 10 paralel · timeout 12s · ip kita 36.85.228.197

    1/10 hidup  1136ms  http://zwasosog:***@45.38.107.97:6014     45.38.107.97
    2/10 mati   6007ms  1.2.3.4:65001                             timeout

hasil 9 hidup · 1 mati · median 1850ms
  → 9 proxy ditulis ke proxy-live.txt
```

### Cara ia menentukan hidup atau mati

Bukan sekadar "koneksi berhasil". Script minta alamat IP lewat proxy itu, lalu
membandingkannya dengan **IP kita sendiri**. Proxy dianggap hidup hanya kalau
target melihat alamat yang bukan alamat kita. Proxy yang diam-diam jatuh ke
koneksi langsung akan lolos kalau syaratnya cuma "ada respons", dan akibatnya
semua akun jalan dari satu IP tanpa ada yang sadar.

IP kita diambil dulu tanpa proxy. Kalau langkah itu gagal, berarti koneksi di
sini yang bermasalah, jadi script berhenti dan **tidak** menandai semua proxy
mati.

### Semua Flag CLI `proxy-check`

| Flag | Deskripsi |
|---|---|
| `--in FILE` | Sumber (default `proxy.txt`). |
| `--out FILE` | Tujuan (default `proxy-live.txt`). |
| `--dead FILE` | Simpan juga yang mati beserta alasannya. |
| `--timeout SEC` | Batas waktu per proxy (default 12). Env: `PROXY_CHECK_TIMEOUT_SEC`. |
| `-c N` / `--concurrency N` | Berapa proxy dicek bersamaan (default 10). Env: `PROXY_CHECK_CONCURRENCY`. |
| `--url URL` | Endpoint pengecek IP (default `https://ipv4.webshare.io/`). Env: `PROXY_CHECK_URL`. |
| `--force` | Tetap tulis file walau tidak ada yang hidup. |
| `-h` / `--help` | Usage. |

Isi `proxy-live.txt` diurutkan **dari yang tercepat**, karena antrean membagikan
proxy sesuai urutan baris, jadi akun-akun pertama dapat yang paling cepat.
Header filenya berupa komentar (`#`) dan diabaikan semua loader.

> **Pengaman:** kalau hasilnya nol hidup padahal `proxy-live.txt` lama masih
> berisi, file lama **tidak** ditimpa. Gangguan koneksi sesaat tidak boleh
> menghapus kolam proxy yang sedang dipakai. Pakai `--force` kalau memang mau
> dikosongkan.

### Kredensial proxy

Chrome tidak menerima user/pass di flag `--proxy-server`, jadi kredensialnya
dikirim lewat `page.authenticate`, dan itu berlaku **per halaman**. Karena OAuth
membuka popup, launcher browser mengautentikasi halaman pertama **dan** setiap
halaman baru di context yang sama. Kalau ini dilewatkan, navigasi pertama mati
dengan `net::ERR_INVALID_AUTH_CREDENTIALS` dan browser terlihat menutup sendiri.

Artinya baris proxy harus lengkap: `http://user:pass@host:port`. Bentuk
`host:port` saja hanya cocok untuk proxy tanpa autentikasi.

### Google sign-in sengaja tidak lewat proxy

Proxy webshare adalah IP datacenter yang dipakai bersama, dan Google menilai
sign-in dari alamat seperti itu cukup buruk untuk menyodorkan **captcha gambar**
di langkah email. Otomasi berhenti di situ.

Karena itu, saat memakai proxy, host autentikasi Google dikirim lewat koneksi
langsung sementara situs yang diotomasi tetap lewat proxy. Satu browser, satu
sesi, tanpa relaunch, jadi cookie dan state OAuth tetap utuh. Mekanismenya flag
Chrome `--proxy-bypass-list`.

Host yang dikirim langsung secara default:

```text
accounts.google.com  accounts.youtube.com  ssl.gstatic.com  www.gstatic.com
```

`www.google.com` **tidak** termasuk. Host itu menyajikan reCAPTCHA untuk situs
yang kita otomasi, dan pengecekan itu harus tetap dari alamat yang sama dengan
yang dilihat situsnya.

| Knob | Efek |
|---|---|
| `--no-google-direct` (env `GOOGLE_DIRECT=0`) | Google ikut lewat proxy. Siap-siap captcha. |
| `GOOGLE_DIRECT_HOSTS=a.com;b.com` | Ganti daftar host yang dikirim langsung. |

> **Konsekuensinya:** semua login Google jadi berasal dari IP rumahmu. Itu jauh
> lebih baik daripada IP datacenter yang sudah ditandai, tapi tetap ada batasnya.
> Jaga `--delay` supaya login tidak menumpuk dalam waktu singkat.

### Satu akun, satu alamat

Pemasangan akun ke proxy tidak lagi bergilir per posisi. Setiap akun dapat
alamat yang belum pernah dipakai akun lain, dan pasangan itu **dicatat di state
file**, jadi run berikutnya tidak mengulang dari awal lalu memberikan alamat
bekas ke akun baru.

Aturannya:

- Akun yang sudah punya alamat tetap memakai alamat itu. Situs sudah melihat
  akun itu dari sana, dan pindah alamat saat retry justru sinyal yang lebih buruk.
- Kalau alamat lamanya sudah hilang dari kolam (mati dan tersaring `proxy-check`),
  akun itu dapat alamat baru.
- Kalau riwayat lama sempat memberi satu alamat ke beberapa akun, hanya akun
  pertama yang mempertahankannya. Sisanya dipindah ke alamat kosong.
- Kalau alamat kosong habis, akun sisanya **ditahan**, bukan didobelkan. Pakai
  `--reuse-proxy` kalau memang mau berbagi.

> **Yang menentukan jumlah akun per batch adalah jumlah IP unik, bukan jumlah
> baris.** Webshare memberi setiap akunnya endpoint yang sama persis, hanya
> username-nya berbeda. Contoh nyata di repo ini: `proxy-live.txt` berisi 129
> baris dari 13 akun webshare, tapi cuma **10 alamat unik**. Jadi memanen lebih
> banyak akun webshare tidak menambah IP. Menu menampilkan angka alamat unik itu,
> bukan jumlah barisnya.

| Knob | Efek |
|---|---|
| `--reuse-proxy` (env `PROXY_REUSE=1`) | Boleh berbagi alamat, kembali bergilir seperti dulu. |
| `--unique-proxy` | Bentuk eksplisit dari default. |

### Proxy mana yang dipakai app

`cbdg` dan `crusoe` membaca **`proxy-live.txt` kalau ada**, dan jatuh ke
`proxy.txt` kalau belum pernah dicek. Kalau `proxy-live.txt` kosong padahal
`proxy.txt` terisi, keduanya memberi peringatan agar `proxy-check` dijalankan
dulu. Override manual tetap bisa lewat `SEED_PROXY` atau `--proxy FILE`.

Urutan lengkapnya:

```bash
bun run webshare       # 1. panen proxy      → proxy.txt
bun run proxy-check    # 2. saring yang mati → proxy-live.txt
bun run crusoe         # 3. pakai            ← proxy-live.txt
```

## 9. Konfigurasi `.env`

Template lengkap: `.env.example`. Bagian relevan per aplikasi:

### Umum

| Variable | Default | Fungsi |
|---|---|---|
| `REGION` | `SG` | Region di `/register/user/complete` (dua huruf ISO / label). |
| `WORKERS` | `1` | Worker paralel. |
| `HEADLESS` | `false` | Jalankan browser tanpa UI. |

### Timeout & retry (detik)

| Variable | Default | Fungsi |
|---|---|---|
| `WAIT_3DS_TIMEOUT_SEC` | `180` | Tunggu penyelesaian 3DS manual. |
| `OPEN_PAYMENT_TIMEOUT_SEC` | `120` | Buka halaman payment profile. |
| `LINK_CARD_TIMEOUT_SEC` | `180` | Proses link kartu VCC. |
| `CREDIT_VERIFY_TIMEOUT_SEC` | `60` | Verifikasi kredit muncul. |
| `MAX_RETRY_PER_ACCOUNT` | `1` | Retry internal per akun. |

### Umpan & output

| Variable | Default | Fungsi |
|---|---|---|
| `SEED_GSUITE` | `./gsuite.txt` | File akun `email:password`. |
| `SEED_VCC` | `./vcc.txt` | File kartu VCC. |
| `SEED_PROXY` | `./proxy.txt` | File proxy (opsional). |
| `STATE_FILE` | `./state.jsonl` | Progres per-state (resume-safe). |
| `RESULT_SUCCESS_FILE` | `./akun-result.txt` | Akun sukses (`email\|timestamp\|region`). |
| `RESULT_FAILED_FILE` | `./akun-failed.txt` | Akun gagal (`email\|timestamp\|alasan`). |
| `RETRY_FAILED` | `false` | Reproses `akun-failed.txt`. |
| `INTER_ACCOUNT_DELAY_SEC` | `0` | Jeda min antar akun per worker (+ jitter 0–50%). Rekomendasi 60–180 tanpa proxy. |
| `SCREENSHOT_DIR` | `./screenshots` | Screenshot error/captcha. |

### Khusus `crusoe`

| Variable | Default | Fungsi |
|---|---|---|
| `SIGNUP_FORM_TIMEOUT_SEC` | `45` | Tunggu form signup. |
| `API_KEY_TIMEOUT_SEC` | `180` | Tunggu API key terbentuk. |
| `CREDITS_TIMEOUT_SEC` | `30` | Tunggu info kredit. |
| `PACE` | `human` | `fast` \| `human` \| `careful`. |
| `CRUSOE_STATE_FILE` | `./state-crusoe.jsonl` | State terpisah dari cbdg. |
| `CRUSOE_RESULT_SUCCESS_FILE` | `./akun-result-crusoe.txt` | Hasil sukses crusoe. |
| `CRUSOE_RESULT_FAILED_FILE` | `./akun-failed-crusoe.txt` | Hasil gagal crusoe. |
| `CRUSOE_APIKEY_FILE` | `./apikey.txt` | API key yang berhasil diextract. |
| `CRUSOE_SCREENSHOT_DIR` | `./screenshots-crusoe` | Screenshot crusoe. |

### Library `@ifqy/google-oauth` (opsional)

`GOOGLE_OAUTH_HEADLESS`, `GOOGLE_OAUTH_CONSENT_MS` (default `90000`),
`GOOGLE_OAUTH_PASSWORD_MS` (`60000`), `GOOGLE_OAUTH_SIGNIN_MS` (`30000`),
`GOOGLE_OAUTH_CAPTCHA_MS` (`180000`), `GOOGLE_OAUTH_FAIL_ON_CAPTCHA` (`true`),
`GOOGLE_OAUTH_PACE`, `GOOGLE_OAUTH_TYPE_MIN/MAX`, `GOOGLE_OAUTH_GENERIC_AUTH_CLICK` —
lihat `.env.example` untuk komentar lengkap.

## 10. Perilaku / Guardrails

- **1 akun = 1 fingerprint.** Setiap akun di-*launch* dengan browser baru
  (stealth + viewport jitter) dan browser **selalu ditutup** setelah akun selesai/gagal.
- **3DS manual:** saat halaman Midas masuk mode verifikasi, bot berhenti dan menunggu
  (`WAIT_3DS_TIMEOUT_SEC`, default 180 dtk), lalu lanjut otomatis saat layar sukses muncul.
- **Resume/skip (default):** re-run **selalu melewati** akun yang sudah ada di
  `akun-result.txt`; akun di `akun-failed.txt` atau state `FAILED` juga dilewati —
  kecuali `--retry-failed`.
- **Crash-safe:** progres tiap state tersimpan di `state.jsonl`; sumber kebenaran hasil
  = `akun-result.txt` / `akun-failed.txt` (email = field pertama, mudah di-parse ulang).
- **Isolasi queue:** satu akun error tidak mematikan antrean.
- **Proxy round-robin** per akun (bila ada); tanpa proxy semua akun memakai 1 IP.
- **`ACCOUNT_RESTRICTED` tidak pernah di-retry** — ban risk-control bersifat permanen.

## 11. Output / Hasil

| File | Isi |
|---|---|
| `akun-result.txt` | `email\|timestamp\|region` — sukses (trial aktif + kredit terverifikasi). |
| `akun-failed.txt` | `email\|timestamp\|alasan` — gagal, bahan `--retry-failed`. |
| `state.jsonl` | Record progres per state (resume-safe, satu JSON per baris). |
| `screenshots/` | Screenshot saat error/captcha. |
| `apikey.txt` | API key crusoe yang berhasil diextract. |
| `akun-result-crusoe.txt` / `akun-failed-crusoe.txt` | Hasil crusoe. |
| `state-crusoe.jsonl` | Progres crusoe. |
| `screenshots-crusoe/` | Screenshot error crusoe. |
| `proxy.txt` | Proxy gratis hasil `webshare`, menumpuk tanpa duplikat. |
| `proxy-live.txt` | Proxy yang lolos `proxy-check`, urut dari tercepat. Ditimpa tiap kali dicek. |
| `proxy-dead.txt` | Opsional (`--dead`): proxy mati beserta alasannya. |
| `akun-result-webshare.txt` / `akun-failed-webshare.txt` | Hasil webshare. |
| `state-webshare.jsonl` | Progres webshare. |
| `screenshots-webshare/` | Screenshot **dan dump HTML** saat webshare gagal baca proxy. |

Status yang mungkin di `state.jsonl` (`FlowState`):

- `cbdg --full`: `PENDING → PRICING → GOOGLE_OAUTH → COMPLETE_REGISTER → ADD_PAYMENT →
  LINK_CARD → WAIT_3DS → START_TRIAL → DONE`
- `cbdg --signup-only`: `PENDING → PRICING → GOOGLE_OAUTH → COMPLETE_REGISTER →
  VERIFY_CREDIT → DONE`
- `crusoe`: `PENDING → SIGNUP → COMPLETE_SIGNUP → API_KEY → DONE`
- `webshare`: `PENDING → SIGNUP → PROXY_LIST → DONE`

Semuanya bisa berakhir `FAILED`.

## 12. Testing & Type Checking

```bash
bun run typecheck     # tsc --noEmit seluruh workspace
bun run test          # semua suite berurutan (library, app-units, runner, queue, crusoe)
```

Suite individual:

```bash
bun run test:library        # @ifqy/google-oauth: utils, config, deteksi URL, integrasi browser asli
bun run test:app-units      # apps/cbdg: config/CLI/loader/JsonlStore/ResultWriter/engine/selector
bun run test:runner         # apps/cbdg: happy path, jalur gagal, browser selalu tertutup
bun run test:queue          # apps/cbdg: pairing kartu, skip terminal, isolasi error, concurrency
bun run test:crusoe-units   # apps/crusoe: unit
bun run test:crusoe-queue   # apps/crusoe: queue
bun run test:webshare-units # apps/webshare: config/selector/format proxy/store
bun run test:webshare-queue # apps/webshare: queue
bun run test:launcher       # scripts/: flag yang disusun launcher + pembaca stdin
bun run test:proxy-check    # scripts/: parsing, verdict hidup/mati, urutan, file keluaran
```

## 13. Alur Kerja Umum

**Run pertama (aman):**

```bash
bun run cbdg -- --dry-run      # pastikan seed & config valid
bun run cbdg                   # headed, 1 akun, biarkan 3DS manual selesai
```

**Run paralel dengan spacing:**

```bash
bun run cbdg -- -w 2 --delay 90
```

**Resume setelah crash / re-run:** cukup jalankan lagi — akun selesai pasti dilewati.

**Retry akun gagal (non-restricted):**

```bash
bun run cbdg -- --retry-failed
```

**Crusoe ala manusia:**

```bash
bun run crusoe -- --delay 60 --pace human
```

**Panen proxy dulu, baru pakai:**

```bash
# 1. isi proxy.txt dari akun-akun webshare
bun run webshare -- --fast --delay 60

# 2. saring yang mati → proxy-live.txt
bun run proxy-check

# 3. pakai yang hidup
bun run crusoe -- --with-proxy --delay 60
bun run cbdg -- --signup-only --with-proxy --delay 60
```

Atau lewat `bun run start` dan pilih **dengan proxy** saat ditanya.

## 14. Menjalankan di VPS tanpa menaruh source di sana

> Butuh langkah salin-tempel saja? Ada di **`docs/VPS.md`**: buat token, pasang,
> jalankan, ambil hasil, cabut token. Bagian ini menjelaskan alasannya.

Kalau VPS-nya disewa dan penyedianya tidak sepenuhnya dipercaya, mulai dari satu
kenyataan ini: **`curl | bash` tidak menyembunyikan apa pun dari pemilik mesin.**
Siapa pun yang punya root bisa membaca berkasnya, memori prosesnya, dan lalu
lintas jaringannya. Yang berubah cuma tingkat kerepotannya.

Dan di folder kerja itu, berkas paling berharga bukan kodenya. `gsuite.txt`
berisi password akun Google dalam bentuk teks biasa.

### Yang dikirim ke VPS

```bash
bun run build:dist
```

Hasilnya `dist/` berisi tiga berkas:

| Berkas | Isi |
|---|---|
| `runner.js` | cbdg, crusoe, webshare, proxy-check dan library `@ifqy/google-oauth`, semuanya dalam satu bundel terminifikasi. Sekitar 91 KB. |
| `package.json` | Tiga paket puppeteer yang dipasang di VPS lewat `bun install`. |
| `RUN.md` | Cara menjalankannya. |

Tidak ada satu pun berkas `.ts`, tidak ada komentar, dan nama fungsi aslinya
hilang. Yang tetap terbaca adalah teks literal seperti selector dan pesan error,
dan itu memang tidak bisa dihilangkan.

Tiga paket puppeteer sengaja tidak ikut dibundel. Paket itu publik, dan stealth
plugin memuat evasion-nya lewat `require` dinamis yang tidak bisa diikuti
bundler mana pun. (`bun build --compile` memang menghasilkan satu binary, tapi
binary-nya mati saat membuka browser dengan `Cannot find package 'kind-of'`.)

### Memasangnya

`dist/` sengaja ikut di-commit ke repo ini, karena dari situlah VPS mengambilnya.

Repo ini private, dan itu tidak jadi masalah: `raw.githubusercontent.com`
melayani repo private asal request-nya membawa token. Sudah diuji, dengan token
HTTP 200 dan tanpa token HTTP 404. Jadi tidak perlu repo publik sama sekali.

```bash
# di laptop: ambil token sekali
gh auth token

# di VPS (ganti <token> dengan hasil di atas)
RAW=https://raw.githubusercontent.com/ifqygazhar/cbdg-testing/main
curl -fsSL -H "Authorization: Bearer <token>" $RAW/scripts/vps-bootstrap.sh |
  bash -s -- --from $RAW/dist --token <token> --ephemeral
```

Tokennya dipakai dua kali: sekali untuk mengambil bootstrap-nya, sekali oleh
bootstrap untuk mengambil `runner.js`. Pakai token yang hanya punya izin baca
untuk repo ini, dan cabut kalau VPS-nya dilepas.

Bootstrap memasang chromium beserta fontnya, memasang bun, mengambil
`runner.js`, menjalankan `bun install`, menyiapkan `gsuite.txt` dan
`proxy-live.txt` dengan izin 600, lalu menulis `run.sh`.

| Flag | Guna |
|---|---|
| `--from URL` | Lokasi bundle. Wajib. |
| `--token TOK` | Kirim `Authorization: Bearer`, untuk rilis privat. |
| `--dir PATH` | Folder kerja, default `~/runner`. |
| `--ephemeral` | Kode di `/dev/shm` (hilang saat reboot), data tetap di `--dir`. |

### Yang dipasang bootstrap, dan yang tidak perlu kamu siapkan

| | Dipasang otomatis |
|---|---|
| chromium atau google-chrome | ya |
| font liberation + noto emoji | ya |
| curl, unzip, ca-certificates | ya |
| bun | ya |
| tiga paket puppeteer | ya, lewat `bun install` |
| `gsuite.txt`, `proxy-live.txt` | dibuat kosong dengan izin 600 |

Jadi tidak ada yang perlu dipasang manual. Yang perlu kamu siapkan cuma isi
`gsuite.txt`.

Alat dasar dipasang **selalu**, bukan cuma saat browser belum ada. Image VPS
yang sudah membawa chromium akan melewatkan tahap itu kalau digabung, lalu bun
gagal dipasang karena installernya butuh `unzip`, dan halaman jadi kotak-kotak
karena fontnya tidak ada.

Di akhir, bootstrap menjalankan `bun runner.js doctor` sebagai uji nyala:

```text
  ok    browser: chromium (/usr/bin/chromium)
  ok    gsuite.txt: 34 akun
  ok    proxy-live.txt: 129 baris
  ok    browser jalan, keluar lewat ip 203.0.113.9
  ok    stealth aktif (navigator.webdriver bukan true)
  ok    proxy pertama hidup, keluar lewat ip 45.38.107.97
```

Browser bisa terpasang tapi tetap tidak mau jalan, biasanya karena shared
library kurang atau `/dev/shm` terlalu kecil di container. Lebih baik ketahuan
di sini daripada saat akun pertama sudah dipakai. Jalankan ulang kapan saja
dengan `bun runner.js doctor`.

### Menaruh kode di RAM supaya hilang tiap reboot

```bash
curl -fsSL <url>/vps-bootstrap.sh | bash -s -- --from <url-dist> --ephemeral
```

`--ephemeral` memisahkan kode dari data:

| | Lokasi | Nasib saat reboot |
|---|---|---|
| `runner.js`, `node_modules` | `/dev/shm/runner-code` | **hilang** |
| `gsuite.txt`, hasil, `logs/`, `run.sh` | `~/runner` | tetap ada |

Pemisahan ini mungkin karena dependensi di-resolve dari sebelah `runner.js`,
sedangkan seed dan hasil mengikuti folder kerja. Jadi kode bisa ditaruh di RAM
tanpa ikut menghapus panenmu. Kalau semuanya ditaruh di `/dev/shm`, reboot juga
akan menghapus `apikey.txt`, `proxy.txt` dan `state.jsonl`, dan akun yang sudah
diproses akan diulang dari nol.

`/dev/shm` adalah tmpfs, jadi isinya benar-benar hilang saat reboot, bukan cuma
ditandai terhapus. Ukurannya sekitar 47 MB (hampir semuanya `node_modules`,
`runner.js` sendiri cuma 94 KB). Default `/dev/shm` adalah separuh RAM, jadi di
VPS 1 GB pun lapang.

Setelah reboot, `run.sh` tidak akan berpura-pura jalan:

```text
kode tidak ada di /dev/shm/runner-code (hilang setelah reboot?)
pasang ulang:
  curl -fsSL <url>/vps-bootstrap.sh | bash -s -- --from <url> --dir /root/runner --ephemeral
```

Perintah pemasangan ulangnya ditulis ke dalam `run.sh` saat bootstrap, jadi
tinggal disalin. Token privat sengaja tidak ikut disimpan; tambahkan sendiri
kalau memang dipakai.

> **Yang tidak dilindungi.** Selama proses jalan, root tetap bisa membaca
> `/dev/shm` dan memori prosesnya. Ephemeral melindungi dari pemeriksaan disk
> **setelah** server mati, bukan dari pemilik mesin yang sedang aktif. Dan
> `gsuite.txt` tetap di disk karena harus bertahan; kalau itu yang paling
> dikhawatirkan, hapus dia setelah batch selesai.

### Menjalankannya supaya laptop boleh dimatikan

```bash
cd ~/runner
nano gsuite.txt

./run.sh start webshare --headless --fast --delay 60
./run.sh logs            # ikuti jalannya
./run.sh status          # dari sesi ssh baru kapan saja
./run.sh stop            # berhenti, chromium-nya ikut dimatikan
```

`run.sh start` melepas proses dari sesi terminal dengan `setsid`, jadi ssh boleh
diputus dan laptop boleh dimatikan. Log tiap run disimpan di `logs/` dengan
stempel waktu, dan baris terakhirnya selalu memuat exit code, jadi run yang
selesai dalam sedetik bisa dibedakan dari yang mati.

Semua perintah juga bisa dipanggil langsung tanpa wrapper:

```bash
bun runner.js cbdg --headless --signup-only --with-proxy --delay 60
bun runner.js proxy-check
```

Urutan yang biasa dipakai:

```bash
./run.sh start webshare --headless --fast --delay 60     # panen proxy
./run.sh start proxy-check                               # saring yang mati
./run.sh start cbdg --headless --signup-only --with-proxy --delay 60
```

Hasilnya menumpuk di folder yang sama: `apikey.txt`, `proxy.txt`,
`proxy-live.txt`, `akun-result-*.txt`, `state-*.jsonl`, dan `screenshots-*/`.
Ambil ke laptop kapan saja:

```bash
scp -r root@ip-vps:'~/runner/*.txt' .
```

Di VPS selalu pakai `--headless`, dan ingat captcha serta 3DS tidak bisa
diselesaikan manual di sana.

### Kalau ternyata yang kamu butuh cuma IP-nya

Tidak perlu menaruh apa pun di VPS:

```bash
ssh -N -D 1080 root@ip-vps                      # biarkan terbuka
echo "socks5://127.0.0.1:1080" > proxy-live.txt
bun run cbdg -- --signup-only --with-proxy --delay 60
```

`ssh -D` membuka SOCKS5 di mesinmu yang keluar lewat IP VPS, dan loader sudah
menerima baris `socks5://`. Bedanya: laptop harus tetap menyala, dan
`proxy-check` tidak bisa menguji baris SOCKS karena ia mengetes lewat HTTP.

## 15. Troubleshooting

| Gejala | Kemungkinan penyebab / solusi |
|---|---|
| `bun: not found` / command error | Bun belum terpasang — install Bun ≥ 1.x. |
| Browser tidak ditemukan | Tidak ada Edge/Chrome/Chromium terpasang di path standar — install salah satunya. |
| `--dry-run` menampilkan log warning | Ada baris seed yang formatnya salah (lihat pesan `skip bad ... line` — perbaiki `gsuite.txt`/`vcc.txt`). |
| Akun jadi `ACCOUNT_RESTRICTED` | Ban risk-control — permanen, tidak akan diproses lagi oleh `--retry-failed`. |
| 3DS tidak pernah selesai | Naikkan `WAIT_3DS_TIMEOUT_SEC` atau selesaikan manual lebih cepat di window browser. |
| Terlalu cepat kena risk-control | Naikkan `--delay` (60–180), pakai proxy, atau `--careful` (crusoe). |
| State korup di `state.jsonl` | JsonlStore menangani baris korup — baris invalid dilewati saat load. |
| Launcher bilang belum ada proxy | Jalankan `webshare` dulu, atau pilih **tanpa proxy**. |
| Launcher bilang proxy "belum dicek" | Jalankan `bun run proxy-check` supaya `proxy-live.txt` terisi. |
| App bilang `proxy-live.txt` kosong padahal `proxy.txt` terisi | Sama: jalankan `proxy-check`, atau pakai `--no-proxy`. |
| `proxy-check` bilang tidak bisa menghubungi endpoint tanpa proxy | Koneksi di mesin ini yang bermasalah. Hasilnya sengaja tidak dipakai supaya proxy tidak salah ditandai mati. |
| Semua proxy mati | Kemungkinan kuota webshare habis atau akunnya kena suspend. Panen ulang dengan akun lain. |
| `PROXY_AUTH_FAILED` / `net::ERR_INVALID_AUTH_CREDENTIALS` | Proxy menolak user/pass. Pastikan baris di file proxy berbentuk `http://user:pass@host:port`, bukan `host:port` saja. |
| `PROXY_UNREACHABLE` | Proxy itu sudah mati sejak pengecekan terakhir. Jalankan `bun run proxy-check` lagi. |
| Banyak akun "kehabisan proxy yang belum terpakai" | Jumlah IP unik lebih sedikit dari jumlah akun. Panen IP baru, tunggu webshare merotasi, atau pakai `--reuse-proxy`. |
| Captcha gambar di langkah email Google (`identifier-stuck`) | Sign-in datang dari IP datacenter. Pastikan `GOOGLE_DIRECT` tidak diset `0`; default-nya sudah mengirim Google lewat koneksi langsung. |
| Mode full berhenti "no cards in vcc.txt" | Isi `vcc.txt`, atau pakai `--signup-only`. |
| Menu tidak bisa panah atas/bawah | Terminalnya bukan TTY (mis. output dipipe). Menu otomatis jatuh ke input angka. |

## 16. Struktur Terkait (untuk konteks)

```
packages/google-oauth/     # library reusable @ifqy/google-oauth
  src/googleAuth.ts          # performGoogleOAuth + helper OAuth
  src/browser.ts             # launch stealth + deteksi browser + proxy
  src/dom.ts                 # clickByText (piercing shadow-DOM), fillInput, dll
  src/antiDetect.ts          # simulasi manusia + viewport jitter
  src/pace.ts, config.ts, screenshot.ts, utils.ts
apps/cbdg/                 # aplikasi flow CodeBuddy
  src/cli.ts                 # entrypoint + parseArgs
  src/config.ts, loaders.ts, store.ts, log.ts
  src/runner.ts              # 1 akun: fingerprint → browser → flow → close
  src/queue.ts               # worker-pool scheduling
  src/flow/engine.ts         # state machine + FlowCtx
  src/flow/steps.ts          # s01 pricing … s07 trial+verify
  src/flow/selectors.ts      # semua selector terpusat
apps/crusoe/               # aplikasi flow Crusoe AI (state/output terpisah)
apps/webshare/             # aplikasi flow Webshare (menulis proxy.txt)
scripts/                   # launcher + tooling
  run.ts                     # menu + spawn app terpilih
  plan.ts                    # jawaban menu → flag (pure, ada test-nya)
  prompt.ts                  # select/confirm/askNumber + pembaca stdin
  proxy-check.ts             # cek proxy.txt → proxy-live.txt
  proxy-lib.ts               # parsing + verdict hidup/mati (pure, ada test-nya)
  runner-entry.ts            # satu entry: cbdg | crusoe | webshare | proxy-check | doctor
  doctor.ts                  # uji nyala: browser, seed, proxy
  build-dist.ts              # bundle terminifikasi untuk dikirim ke VPS
  vps-bootstrap.sh           # installer sekali jalan di VPS (curl | bash)
dataset_target/            # HTML asli (dipakai test validasi selector)
crusoe_ai_dataset/         # HTML asli crusoe (dipakai test validasi selector)
webshare_dataset/          # HTML asli webshare (dipakai test validasi selector)
.claude/skills/browser-signup-automation/   # playbook + katalog kegagalan
docs/plans/                # rencana implementasi
```