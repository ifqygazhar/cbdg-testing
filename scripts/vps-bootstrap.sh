#!/usr/bin/env bash
# ── Pasang runner di VPS ───────────────────────────────────────────
#
#   curl -fsSL <url>/vps-bootstrap.sh | bash -s -- --from <url-bundle>
#
# Yang dikirim ke VPS cuma bundle terminifikasi hasil `bun run build:dist`,
# bukan source TypeScript-nya.
#
# Jujur soal batasannya: ini TIDAK menyembunyikan apa pun dari pemilik VPS.
# Siapa pun yang punya root bisa membaca berkas, memori proses, dan lalu
# lintas jaringannya. Yang dikurangi hanyalah kemudahannya, dan file paling
# berharga di sini bukan kodenya melainkan gsuite.txt yang berisi password
# akun Google. Kalau penyedia VPS-nya memang tidak dipercaya, jangan taruh
# keduanya di sana.

set -euo pipefail

FROM=""
TOKEN=""
DIR="${HOME}/runner"
EPHEMERAL=0
BUNDLE="runner.js"

die() { printf '\033[31m[bootstrap] %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[36m[bootstrap]\033[0m %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: bash vps-bootstrap.sh --from <base-url> [opsi]

  --from URL     Lokasi bundle (runner.js + package.json). Wajib.
  --token TOK    Authorization: Bearer <tok>, untuk rilis privat.
  --dir PATH     Folder kerja (default ~/runner).
  --ephemeral    Taruh KODE di /dev/shm (RAM) supaya hilang saat reboot.
                 Seed dan hasil tetap di --dir yang permanen.
  --help         Tampilkan ini.

Setelah selesai: isi gsuite.txt, lalu jalankan salah satu app.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --ephemeral) EPHEMERAL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "opsi tidak dikenal: $1 (pakai --help)" ;;
  esac
done

[ -n "$FROM" ] || { usage; die "--from wajib diisi"; }
FROM="${FROM%/}"

# Kode dan data sengaja dipisah. Dependensi di-resolve dari sebelah runner.js,
# sedangkan seed dan hasil mengikuti folder kerja, jadi kode bisa ditaruh di
# RAM (hilang saat reboot) tanpa ikut menghapus hasil panennya.
DATA_DIR="$DIR"
if [ "$EPHEMERAL" -eq 1 ]; then
  CODE_DIR="/dev/shm/runner-code"
else
  CODE_DIR="$DIR"
fi

# ── 1. paket sistem ────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "bukan root dan sudo tidak ada"
  SUDO="sudo"
fi

# Alat dasar dipasang TERPISAH dan selalu. Kalau ikut di dalam pemasangan
# browser, image yang sudah punya chromium akan melewatinya, lalu bun gagal
# dipasang karena installernya butuh unzip, dan fontnya hilang sehingga semua
# halaman jadi kotak-kotak.
install_base() {
  if command -v apt-get >/dev/null; then
    say "memasang alat dasar (apt)"
    $SUDO apt-get update -qq
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq       ca-certificates curl unzip fonts-liberation fonts-noto-color-emoji >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null; then
    say "memasang alat dasar (dnf)"
    $SUDO dnf install -y -q ca-certificates curl unzip       liberation-fonts google-noto-emoji-color-fonts >/dev/null 2>&1 || true
  elif command -v apk >/dev/null; then
    say "memasang alat dasar (apk)"
    $SUDO apk add --no-cache ca-certificates curl unzip bash       font-noto font-noto-emoji >/dev/null 2>&1 || true
  fi
  command -v curl >/dev/null || die "curl tidak ada dan tidak bisa dipasang"
  command -v unzip >/dev/null || say "peringatan: unzip tidak ada, pemasangan bun bisa gagal"
}

install_packages() {
  if command -v apt-get >/dev/null; then
    say "memasang browser (apt)"
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq chromium >/dev/null 2>&1 || true
    if ! browser_path >/dev/null; then
      # Di Ubuntu paket chromium cuma pembungkus snap, dan snap tidak bisa
      # diandalkan di sesi non-interaktif. Chrome resmi dari .deb membawa
      # dependensinya sendiri.
      say "chromium tidak tersedia sebagai paket biasa — memasang google chrome"
      curl -fsSL -o /tmp/chrome.deb         https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb ||
        die "gagal mengunduh google chrome"
      DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq /tmp/chrome.deb >/dev/null 2>&1 ||
        die "gagal memasang google chrome"
      rm -f /tmp/chrome.deb
    fi
  elif command -v dnf >/dev/null; then
    say "memasang browser (dnf)"
    $SUDO dnf install -y -q chromium >/dev/null
  elif command -v apk >/dev/null; then
    say "memasang browser (apk)"
    $SUDO apk add --no-cache chromium >/dev/null
  else
    die "package manager tidak dikenal — pasang chromium manual lalu ulangi"
  fi
}

browser_path() {
  for candidate in /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    [ -x "$candidate" ] && echo "$candidate" && return 0
  done
  return 1
}

install_base
BROWSER="$(browser_path || true)"
if [ -z "$BROWSER" ]; then
  install_packages
  BROWSER="$(browser_path || true)"
fi
[ -n "$BROWSER" ] || die "chromium tetap tidak ditemukan setelah instalasi"
say "browser: $BROWSER"

# ── 2. bun ─────────────────────────────────────────────────────────
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null; then
  say "memasang bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "gagal memasang bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null || die "bun terpasang tapi tidak ada di PATH"
say "bun: $(bun --version)"

# ── 3. ambil bundle ────────────────────────────────────────────────
mkdir -p "$CODE_DIR" "$DATA_DIR"
cd "$CODE_DIR"

fetch() {
  local name="$1"
  if [ -n "$TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$name" "$FROM/$name"
  else
    curl -fsSL -o "$name" "$FROM/$name"
  fi
}

say "mengambil bundle dari $FROM"
fetch package.json || die "tidak bisa mengambil package.json dari $FROM"
fetch "$BUNDLE" || die "tidak bisa mengambil $BUNDLE"

say "memasang dependensi publik (puppeteer)"
bun install --silent >/dev/null 2>&1 || bun install || die "bun install gagal"

# ── 4. seed ────────────────────────────────────────────────────────
cd "$DATA_DIR"
if [ ! -s gsuite.txt ]; then
  cat > gsuite.txt <<'SEED'
# satu akun per baris:  email:password
# contoh:
# user.satu@domain.com:PasswordRahasia123
SEED
  say "gsuite.txt dibuat — isi dulu sebelum menjalankan apa pun"
fi
if [ ! -s proxy-live.txt ]; then
  cat > proxy-live.txt <<'SEED'
# opsional. satu proxy per baris:
#   http://user:pass@host:port
#   socks5://127.0.0.1:1080
SEED
fi
chmod 600 gsuite.txt proxy-live.txt 2>/dev/null || true

# ── 5. wrapper biar bisa ditinggal ─────────────────────────────────
# Tanpa ini, proses ikut mati begitu ssh putus. setsid melepasnya dari sesi
# terminal, jadi laptop boleh dimatikan.
cat > run.sh <<RUNNER_HEADER
#!/usr/bin/env bash
set -euo pipefail
# Ditulis oleh vps-bootstrap.sh
CODE_DIR="$CODE_DIR"
RESTORE="curl -fsSL <url>/vps-bootstrap.sh | bash -s -- --from $FROM --dir $DATA_DIR$([ "$EPHEMERAL" -eq 1 ] && echo " --ephemeral")"
RUNNER_HEADER
cat >> run.sh <<'RUNNER'
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"
mkdir -p logs
PIDFILE=.runner.pid

# Kodenya bisa ada di RAM. Setelah reboot ia hilang, dan itu memang disengaja —
# yang penting pesannya jelas, bukan error "module not found" yang bikin bingung.
if [ ! -f "$CODE_DIR/runner.js" ]; then
  echo "kode tidak ada di $CODE_DIR (hilang setelah reboot?)" >&2
  echo "pasang ulang:" >&2
  echo "  $RESTORE" >&2
  exit 1
fi

# Log terbaru dicari dari isi folder, bukan dari symlink: sebagian filesystem
# tidak punya symlink, dan link yang gagal dibuat tidak boleh bikin buta.
latest_log() { ls -1t logs/*.log 2>/dev/null | head -1; }

running() {
  [ -f "$PIDFILE" ] || return 1
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    shift
    [ $# -gt 0 ] || { echo "Usage: ./run.sh start <perintah> [flag...]" >&2; exit 1; }
    if running; then
      echo "masih ada yang jalan (pid $(cat "$PIDFILE")). ./run.sh stop dulu." >&2
      exit 1
    fi
    LOG="logs/$1-$(date +%Y%m%d-%H%M%S).log"
    # setsid melepas proses dari sesi terminal, jadi ssh boleh diputus dan
    # laptop boleh dimatikan. Kalau setsid tidak ada, nohup masih menolong.
    # Exit code ikut ditulis ke log. Tanpa itu, perintah yang selesai dalam
    # sedetik (proxy-check, --dry-run) tidak bisa dibedakan dari yang mati.
    INNER='bun "$CODE_DIR/runner.js" "$@"; echo "[run.sh] selesai exit=$?"'
    if command -v setsid >/dev/null; then
      setsid nohup env CODE_DIR="$CODE_DIR" bash -c "$INNER" _ "$@" >"$LOG" 2>&1 < /dev/null &
    else
      nohup env CODE_DIR="$CODE_DIR" bash -c "$INNER" _ "$@" >"$LOG" 2>&1 < /dev/null &
    fi
    echo $! > "$PIDFILE"
    echo "jalan di background (pid $(cat "$PIDFILE"))"
    echo "log: $LOG"
    sleep 1
    if running; then
      echo "pantau: ./run.sh logs"
    else
      rm -f "$PIDFILE"
      echo "sudah selesai. baris terakhir:"
      tail -3 "$LOG"
    fi
    ;;
  logs)
    LOG="$(latest_log)"
    [ -n "$LOG" ] || { echo "belum ada log" >&2; exit 1; }
    tail -f "$LOG"
    ;;
  status)
    LOG="$(latest_log)"
    if running; then
      echo "jalan, pid $(cat "$PIDFILE")"
    else
      echo "tidak ada yang jalan"
    fi
    [ -n "$LOG" ] && { echo "log: $LOG"; tail -3 "$LOG"; }
    ;;
  stop)
    if running; then
      PID="$(cat "$PIDFILE")"
      # Bunuh satu grup proses: kalau cuma pid induknya, chromium jadi yatim
      # dan tetap memakan RAM.
      kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
      sleep 2
      kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "dihentikan"
    else
      rm -f "$PIDFILE"
      echo "tidak ada yang jalan"
    fi
    ;;
  *)
    cat <<USAGE
Usage:
  ./run.sh start <perintah> [flag...]   jalan di background, aman ditinggal
  ./run.sh logs                         ikuti log yang sedang berjalan
  ./run.sh status                       cek masih jalan atau tidak
  ./run.sh stop                         hentikan (beserta chromium-nya)

Perintah: webshare | proxy-check | crusoe | cbdg
Contoh:
  ./run.sh start webshare --headless --fast --delay 60
  ./run.sh start cbdg --headless --signup-only --with-proxy --delay 60
USAGE
    ;;
esac
RUNNER
chmod +x run.sh

# ── 6. cek kesiapan ────────────────────────────────────────────────
# Browser bisa terpasang tapi tetap tidak mau jalan (shared library kurang,
# /dev/shm terlalu kecil). Lebih baik ketahuan sekarang daripada saat akun
# pertama sudah dipakai.
say "menguji browser"
(cd "$DATA_DIR" && bun "$CODE_DIR/runner.js" doctor --no-proxy) ||
  say "ada yang belum beres di atas — perbaiki sebelum menjalankan akun"

# ── 7. selesai ─────────────────────────────────────────────────────
cat <<DONE

siap. folder kerja: $DIR

  1. isi akun:   nano $DIR/gsuite.txt
  2. jalankan (aman ditinggal, laptop boleh dimatikan):

     cd $DIR
     bun runner.js doctor   # cek ulang kapan saja
     ./run.sh start webshare --headless --fast --delay 60
     ./run.sh logs          # ikuti jalannya
     ./run.sh status        # cek dari sesi ssh baru
     ./run.sh stop

  3. urutan yang biasa dipakai:

     ./run.sh start webshare --headless --fast --delay 60
     ./run.sh start proxy-check
     ./run.sh start cbdg --headless --signup-only --with-proxy --delay 60

catatan:
  - VPS tidak punya layar, jadi selalu --headless. Captcha dan 3DS tidak bisa
    diselesaikan manual di sana; akun yang kena akan dicatat sebagai gagal.
  - hasil ada di folder ini juga: apikey.txt, proxy.txt, akun-result-*.txt.
    Ambil ke laptop dengan: scp -r <user>@<host>:$DIR/'*.txt' .
  - gsuite.txt berisi password Google. Kalau penyedia VPS-nya tidak dipercaya,
    file ini kerugian yang lebih besar daripada kodenya.
DONE
[ "$EPHEMERAL" -eq 1 ] && echo "  - mode ephemeral: $DIR ada di RAM dan hilang saat reboot."
