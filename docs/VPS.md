# Menjalankan di VPS — panduan salin-tempel

Semua perintah di bawah tinggal disalin. Urutannya dari atas ke bawah.

> Kalau branch `feat/vps-bundle-runner` belum digabung ke `main`, ganti `main`
> pada `BRANCH` di langkah 2 dengan nama branch itu.

---

## 1. Buat token (di laptop, lewat browser)

**Jangan pakai `gh auth token`.** Token itu punya scope `repo`, `gist`,
`read:org` dan `workflow` untuk **semua** repo-mu. Kalau VPS-nya jebol, seluruh
akun GitHub-mu ikut jebol.

Buat token khusus yang cuma bisa membaca satu repo ini:

1. Buka <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: `vps-runner`
3. **Expiration**: 30 hari (atau sependek mungkin)
4. **Repository access** → *Only select repositories* → pilih `cbdg-testing`
5. **Permissions** → *Repository permissions* → **Contents: Read-only**
6. Generate, lalu salin tokennya (`github_pat_...`)

Token ini cuma bisa membaca isi satu repo. Tidak bisa menulis, tidak bisa
menyentuh repo lain.

---

## 2. Pasang di VPS

```bash
ssh root@IP-VPS
```

Lalu di VPS (ganti `github_pat_xxx` dengan tokenmu):

```bash
export TOKEN=github_pat_xxx
export BRANCH=main
export RAW=https://raw.githubusercontent.com/ifqygazhar/cbdg-testing/$BRANCH

curl -fsSL -H "Authorization: Bearer $TOKEN" $RAW/scripts/vps-bootstrap.sh |
  bash -s -- --from $RAW/dist --token $TOKEN --dir ~/runner --ephemeral
```

Bootstrap memasang chromium, font, bun, mengambil `runner.js`, menjalankan
`bun install`, lalu menguji browsernya. Yang terakhir muncul kira-kira begini:

```text
  ok    browser: chromium (/usr/bin/chromium)
  ok    browser jalan, keluar lewat ip 203.0.113.9
  ok    stealth aktif (navigator.webdriver bukan true)
```

Kalau ada baris `GAGAL`, beresin dulu sebelum lanjut.

---

## 3. Isi akun

```bash
nano ~/runner/gsuite.txt
```

Satu akun per baris:

```text
user.satu@domain.com:PasswordRahasia123
user.dua@domain.com:PasswordLain456
```

Simpan dengan `Ctrl+O`, `Enter`, lalu `Ctrl+X`.

---

## 4. Perlu set `.env` dulu?

**Tidak perlu.** Semua punya nilai bawaan, dan flag di baris perintah sudah
menutupi yang penting. Dua bawaan yang perlu kamu tahu:

| Bawaan | Akibatnya di VPS | Penawarnya |
|---|---|---|
| browser jalan *headed* | VPS tidak punya layar, browser gagal dibuka | selalu tambah `--headless` |
| cbdg jalan mode *full* | butuh `vcc.txt`, antrean berhenti kalau kosong | pakai `--signup-only` |

Contoh perintah di bawah sudah memakai keduanya, jadi tidak ada yang perlu
disiapkan lagi.

Kalau memang mau menyetel lewat berkas, buat `~/runner/.env`:

```bash
cat > ~/runner/.env <<'EOF'
HEADLESS=true
MODE=signup
PACE=human
INTER_ACCOUNT_DELAY_SEC=60
EOF
```

---

## 5. Jalankan

Selalu lewat `./run.sh start`. Perintah itu melepas prosesnya dari sesi
terminal, jadi **ssh boleh diputus dan laptop boleh dimatikan**.

```bash
cd ~/runner

# panen proxy gratis dulu
./run.sh start webshare --headless --fast --delay 60

# pantau (Ctrl+C cuma menutup pantauan, prosesnya tetap jalan)
./run.sh logs
```

Setelah webshare selesai, saring proxy yang mati:

```bash
./run.sh start proxy-check
```

Lalu jalankan yang butuh proxy:

```bash
./run.sh start cbdg --headless --signup-only --with-proxy --delay 60
./run.sh start crusoe --headless --fast --with-proxy --delay 60
```

Perintah lain:

```bash
./run.sh status      # masih jalan atau tidak, plus 3 baris log terakhir
./run.sh stop        # hentikan, chromium-nya ikut dimatikan
./run.sh doctor      # cek ulang kesiapan kapan saja
```

Hanya satu pekerjaan boleh jalan dalam satu waktu. `./run.sh start` akan
menolak kalau masih ada yang berjalan.

---

## 6. Ambil hasilnya ke laptop

Hasil menumpuk di `~/runner` di VPS. Dari **laptop**:

```bash
scp -r root@IP-VPS:'~/runner/*.txt' .
scp -r root@IP-VPS:'~/runner/screenshots-*' .
```

Isinya: `apikey.txt` (Crusoe), `proxy.txt` dan `proxy-live.txt` (Webshare),
`akun-result*.txt`, `akun-failed*.txt`.

---

## 7. Setelah VPS di-reboot

Karena dipasang dengan `--ephemeral`, kodenya ada di RAM dan hilang saat
reboot. Seed dan hasil tetap ada. `./run.sh` akan bilang:

```text
kode tidak ada di /dev/shm/runner-code (hilang setelah reboot?)
pasang ulang:
  curl -fsSL <url>/vps-bootstrap.sh | bash -s -- --from ... --dir ... --ephemeral
```

Pasang ulang dengan perintah yang sama persis seperti langkah 2. Tokennya perlu
diisi lagi karena sengaja tidak disimpan di disk.

---

## 8. Cabut token kalau sudah selesai

Lakukan ini setiap kali VPS-nya dilepas atau pekerjaannya rampung.

1. Buka <https://github.com/settings/personal-access-tokens>
2. Cari `vps-runner`
3. Klik nama tokennya → tombol **Revoke** di kanan atas → konfirmasi

Begitu dicabut, token itu langsung mati di mana pun ia tersimpan. Kalau kamu
memberi tanggal kedaluwarsa di langkah 1, ia juga mati sendiri pada tanggal itu.

Bersihkan juga jejaknya di VPS:

```bash
unset TOKEN
history -c
```

---

## Kalau ada yang gagal

| Gejala | Artinya |
|---|---|
| `HTTP 404` saat mengambil bootstrap | Token salah, kedaluwarsa, atau `BRANCH` tidak cocok |
| `chromium tidak bisa dipasang otomatis` | Distro tidak dikenal, pasang chromium manual lalu ulangi |
| `doctor` bilang browser gagal dijalankan | Biasanya RAM kurang; VPS 1 GB adalah batas bawah |
| `proxy-live.txt kosong padahal proxy.txt terisi` | Jalankan `./run.sh start proxy-check` |
| Banyak akun `kehabisan proxy yang belum terpakai` | IP unik lebih sedikit dari jumlah akun, panen lagi atau pakai `--reuse-proxy` |
| `ACCOUNT_RESTRICTED` | Blokir dari sisi mereka, akun itu tidak akan diulang |

Log lengkap tiap run ada di `~/runner/logs/`.
