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

Lalu di VPS. Ganti `github_pat_xxx` dengan tokenmu:

```bash
export TOKEN=github_pat_xxx
export API=https://api.github.com/repos/ifqygazhar/cbdg-testing/contents

curl -fsSL -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github.raw" \
  "$API/scripts/vps-bootstrap.sh?ref=main" |
  bash -s -- --from $API/dist --token $TOKEN --ref main --dir ~/runner --ephemeral
```

> **Kenapa `api.github.com`, bukan `raw.githubusercontent.com`?**
> Token fine-grained (`github_pat_...`) ditolak oleh `raw.githubusercontent.com`
> dan jawabannya **404**, sama persis dengan jawaban untuk berkas yang memang
> tidak ada. Endpoint API menerima token fine-grained maupun klasik, jadi
> bentuk ini yang dipakai. Bootstrap mengenali kedua bentuk URL.

Bootstrap memasang chromium, font, Xvfb, bun, mengambil `runner.js`,
menjalankan `bun install`, lalu menguji browsernya. Yang terakhir muncul
kira-kira begini:

```text
  ok    browser: chromium (/usr/bin/chromium)
  ok    browser jalan, keluar lewat ip 203.0.113.9
  ok    stealth aktif (navigator.webdriver bukan true)
```

Kalau ada baris `GAGAL`, beresin dulu sebelum lanjut.

### Kalau masih 404

Uji tokennya sendiri dulu, di VPS:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/ifqygazhar/cbdg-testing
```

| Hasil | Artinya |
|---|---|
| `200` | Token benar. Kalau tetap 404 saat mengambil berkas, periksa ejaan path dan `--ref`. |
| `404` | Token tidak punya akses ke repo ini. Di halaman token, pastikan *Only select repositories* memuat `cbdg-testing` dan *Contents* diset **Read-only**. |
| `401` | Token salah ketik, kedaluwarsa, atau sudah dicabut. |

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
| browser jalan *headed* | VPS tidak punya layar | tambah `--headless`, atau biarkan Xvfb yang menanganinya (bagian 9) |
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

## 9. Headless, Xvfb, dan screenshot

### Screenshot saat gagal sudah otomatis

Tidak perlu menyalakan apa pun. Setiap kegagalan yang bisa diduga sudah memotret
layarnya sendiri, dan itu berjalan di headless juga karena potretnya diambil
lewat protokol browser, bukan dari layar fisik.

Yang dipotret: captcha Google, halaman sign-in yang mandek, akun yang diblokir,
tombol Google yang tak muncul, dashboard yang tak terbuka, form kartu yang
hilang, sampai API key yang gagal dibaca. Untuk dua kasus terakhir, HTML
halamannya ikut disimpan supaya nilainya masih bisa diambil manual.

Semuanya mendarat di `~/runner/screenshots*/`. Ambil ke laptop:

```bash
scp -r root@IP-VPS:'~/runner/screenshots-*' .
```

### Xvfb: jalan headed di mesin tanpa monitor

Bisa, dan bootstrap sudah memasang `xvfb` untukmu. Cukup **jangan** menulis
`--headless`:

```bash
./run.sh start cbdg --signup-only --with-proxy --delay 60
```

`run.sh` memeriksa sendiri: ada `--headless` maka jalan langsung, tidak ada maka
dibungkus `xvfb-run` dengan layar palsu 1280x800. Kalau Xvfb tidak terpasang dan
tidak ada `DISPLAY`, ia berhenti dengan pesan jelas, bukan gagal setengah jalan.

| | `--headless` | tanpa `--headless` (Xvfb) |
|---|---|---|
| RAM | ~400-700 MB | ~700 MB-1 GB |
| Sidik jari | build headless punya ciri khas sendiri | jendela Chrome biasa |
| Screenshot | jalan | jalan |
| Captcha manual | tidak bisa | tidak bisa juga, kecuali dipasangi VNC |

Stealth plugin memang sudah menambal penanda headless yang paling umum, jadi
headless bukan berarti pasti ketahuan. Xvfb menutup sisa penanda yang tidak
ditambal, dengan ongkos RAM. Di VPS 1 GB, pilih `--headless`. Di 2 GB ke atas,
Xvfb layak dicoba, terutama kalau kamu curiga blokirnya karena deteksi browser.

Cek mana yang tersedia:

```bash
./run.sh doctor
```

Barisnya akan menyebut salah satu:

```text
  ok    layar: xvfb-run terpasang — mode headed jalan di layar palsu
  ·     layar: tidak ada, dan xvfb-run belum terpasang — pakai --headless
```

### Kalau mau benar-benar melihat layarnya

Xvfb tidak punya penonton. Tambahkan VNC kalau ingin mengintip atau
menyelesaikan captcha sendiri:

```bash
# di VPS
apt-get install -y x11vnc
Xvfb :99 -screen 0 1280x800x24 &
DISPLAY=:99 x11vnc -localhost -nopw -forever &

# di laptop, terowongkan lalu buka dengan klien VNC ke localhost:5900
ssh -N -L 5900:127.0.0.1:5900 root@IP-VPS
```

Lalu jalankan dengan `DISPLAY=:99` supaya memakai layar yang sama:

```bash
DISPLAY=:99 ./run.sh start cbdg --signup-only --delay 60
```

`run.sh` melihat `DISPLAY` sudah ada dan tidak akan membungkusnya lagi dengan
Xvfb. Jangan buka port 5900 ke internet; `-localhost` sudah menguncinya ke
terowongan ssh.

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
