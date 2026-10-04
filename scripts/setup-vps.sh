#!/usr/bin/env bash
# ==============================================================================
# VPS Setup Script (Ubuntu / Debian)
# Repository: cbdg-credit-automation
#
# Fungsi:
# 1. Update OS & install dependencies sistem (Chromium/Chrome, Xvfb, fonts, dll)
# 2. Install Bun runtime
# 3. Setup Python virtualenv (~/.venvs/camoufox) + Camoufox Anti-Detect Browser
# 4. Generate & Setup SSH Key untuk GitHub (clone private repo)
# ==============================================================================

set -euo pipefail

# Warna output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

echo -e "${BOLD}${BLUE}====================================================================${NC}"
echo -e "${BOLD}${BLUE}       🚀 AUTOMATION RUNNER VPS SETUP (Ubuntu / Debian)             ${NC}"
echo -e "${BOLD}${BLUE}====================================================================${NC}\n"

# 1. Pastikan hak akses root / sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        warn "Script dijalankan sebagai non-root. Menggunakan sudo..."
    else
        err "Script ini membutuhkan hak akses root atau sudo."
        exit 1
    fi
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# 2. Update sistem & instal paket dasar
info "1/5. Memperbarui package repository dan menginstal alat dasar..."
$SUDO apt-get update -qq

$SUDO apt-get install -y -qq \
    ca-certificates \
    curl \
    wget \
    git \
    unzip \
    tar \
    build-essential \
    jq \
    tmux \
    htop \
    openssh-client \
    xvfb \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libxshmfence1 \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev >/dev/null 2>&1 || true

# Penanganan kompatibilitas libasound di Ubuntu 22.04 vs 24.04
$SUDO apt-get install -y -qq libasound2 >/dev/null 2>&1 || \
$SUDO apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || true

ok "Paket dasar sistem berhasil diinstal."

# 3. Instal Google Chrome / Chromium jika belum ada
info "2/5. Memeriksa browser Google Chrome / Chromium..."
if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
    info "Mengunduh dan menginstal Google Chrome Stable..."
    CHROME_DEB="/tmp/google-chrome-stable_current_amd64.deb"
    curl -fsSL -o "$CHROME_DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || true
    if [ -f "$CHROME_DEB" ]; then
        $SUDO apt-get install -y -qq "$CHROME_DEB" >/dev/null 2>&1 || true
        rm -f "$CHROME_DEB"
    fi
fi

if command -v google-chrome >/dev/null 2>&1; then
    ok "Browser: $(google-chrome --version)"
elif command -v chromium >/dev/null 2>&1; then
    ok "Browser: $(chromium --version)"
elif command -v chromium-browser >/dev/null 2>&1; then
    ok "Browser: $(chromium-browser --version)"
else
    warn "Google Chrome tidak berhasil diinstal via deb, mencoba pasang chromium via apt..."
    $SUDO apt-get install -y -qq chromium-browser >/dev/null 2>&1 || true
fi

# 4. Instal Bun Runtime
info "3/5. Memeriksa runtime Bun..."
BUN_DIR="$HOME/.bun"
if ! command -v bun >/dev/null 2>&1; then
    info "Menginstal Bun..."
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
fi

export BUN_INSTALL="$BUN_DIR"
export PATH="$BUN_INSTALL/bin:$PATH"

# Simpan ke .bashrc jika belum ada
if ! grep -q 'BUN_INSTALL' "$HOME/.bashrc" 2>/dev/null; then
    cat >> "$HOME/.bashrc" <<'EOF'

# Bun runtime
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
fi

if command -v bun >/dev/null 2>&1; then
    ok "Bun runtime: $(bun --version)"
else
    err "Gagal menemukan bun setelah instalasi."
    exit 1
fi

# 5. Setup Python Virtualenv & Camoufox
info "4/5. Menyiapkan Python virtual environment & Camoufox anti-bot browser..."
VENV_DIR="$HOME/.venvs/camoufox"
mkdir -p "$(dirname "$VENV_DIR")"

if [ ! -f "$VENV_DIR/bin/python" ]; then
    info "Membuat virtualenv Python di $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

info "Menginstal paket Python (camoufox, playwright, PySocks, aiohttp, dll)..."
"$VENV_DIR/bin/pip" install --upgrade pip -q >/dev/null 2>&1
"$VENV_DIR/bin/pip" install -q \
    "camoufox[geoip]" \
    playwright \
    PySocks \
    requests \
    aiohttp \
    orjson \
    screeninfo >/dev/null 2>&1

info "Mengunduh binary browser Camoufox..."
"$VENV_DIR/bin/camoufox" fetch >/dev/null 2>&1 || warn "camoufox fetch mengeluarkan peringatan, browser akan diunduh saat run pertama."

# Simpan environment CAMOUFOX_PYTHON ke .bashrc
if ! grep -q 'CAMOUFOX_PYTHON' "$HOME/.bashrc" 2>/dev/null; then
    cat >> "$HOME/.bashrc" <<EOF

# Camoufox Python
export CAMOUFOX_PYTHON="$VENV_DIR/bin/python"
export PATH="$VENV_DIR/bin:\$PATH"
EOF
fi
export CAMOUFOX_PYTHON="$VENV_DIR/bin/python"
export PATH="$VENV_DIR/bin:$PATH"

ok "Python environment siap di: $VENV_DIR/bin/python"

# 6. Setup SSH Key untuk GitHub
info "5/5. Menyiapkan SSH Key untuk koneksi ke GitHub..."
SSH_DIR="$HOME/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

KEY_FILE="$SSH_DIR/id_ed25519"
PUB_FILE="$SSH_DIR/id_ed25519.pub"

if [ ! -f "$KEY_FILE" ]; then
    HOSTNAME_STR="$(hostname 2>/dev/null || echo 'vps')"
    ssh-keygen -t ed25519 -C "vps-${HOSTNAME_STR}-$(date +%Y%m%d)" -f "$KEY_FILE" -N "" >/dev/null 2>&1
    ok "SSH Key baru berhasil dibuat: $KEY_FILE"
else
    info "SSH Key yang sudah ada ditemukan di: $KEY_FILE"
fi

chmod 600 "$KEY_FILE"
chmod 644 "$PUB_FILE"

# Pre-fetch GitHub known_hosts agar tidak muncul prompt 'Are you sure you want to continue connecting?'
ssh-keyscan -t ed25519,rsa github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
sort -u "$SSH_DIR/known_hosts" -o "$SSH_DIR/known_hosts" 2>/dev/null || true

# Setup ~/.ssh/config untuk github.com
CONFIG_FILE="$SSH_DIR/config"
if ! grep -q 'github.com' "$CONFIG_FILE" 2>/dev/null; then
    cat >> "$CONFIG_FILE" <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF
    chmod 600 "$CONFIG_FILE"
fi

# Jalankan ssh-agent jika belum aktif & tambahkan key
eval "$(ssh-agent -s)" >/dev/null 2>&1 || true
ssh-add "$KEY_FILE" >/dev/null 2>&1 || true

PUBLIC_KEY_CONTENT="$(cat "$PUB_FILE")"

echo -e "\n${BOLD}${GREEN}====================================================================${NC}"
echo -e "${BOLD}${GREEN}       ✅ SETUP LINGKUNGAN VPS SELESAI DENGAN SUKSES!               ${NC}"
echo -e "${BOLD}${GREEN}====================================================================${NC}\n"

echo -e "${BOLD}${YELLOW}📋 SALIN KODE SSH PUBLIC KEY DI BAWAH INI:${NC}"
echo -e "${CYAN}--------------------------------------------------------------------${NC}"
echo -e "${BOLD}${PUBLIC_KEY_CONTENT}${NC}"
echo -e "${CYAN}--------------------------------------------------------------------${NC}\n"

echo -e "${BOLD}LANGKAH MENYAMBUNGKAN KE GITHUB:${NC}"
echo -e " 1. Buka browser dan login ke GitHub Anda: ${CYAN}https://github.com/settings/keys${NC}"
echo -e " 2. Klik tombol hijau ${BOLD}'New SSH key'${NC}."
echo -e " 3. Isi ${BOLD}Title${NC} (misal: ${GREEN}VPS SG 9iwb6${NC})."
echo -e " 4. Paste seluruh baris ${BOLD}SSH Public Key${NC} di atas ke dalam kolom ${BOLD}'Key'${NC}."
echo -e " 5. Klik ${BOLD}'Add SSH key'${NC}.\n"

echo -e "${BOLD}CARA TES KONEKSI & CLONE REPO:${NC}"
echo -e " 1. Tes koneksi GitHub dari VPS:"
echo -e "    ${GREEN}ssh -T git@github.com${NC}"
echo -e "    ${YELLOW}(Jika sukses, akan muncul: 'Hi <username>! You\\'ve successfully authenticated...')${NC}\n"
echo -e " 2. Clone repository private Anda:"
echo -e "    ${GREEN}git clone git@github.com:USERNAME/REPO_NAME.git${NC}\n"
echo -e " 3. Masuk ke folder repo & pasang dependencies:"
echo -e "    ${GREEN}cd REPO_NAME${NC}"
echo -e "    ${GREEN}bun install${NC}\n"
echo -e " 4. Menjalankan runner:"
echo -e "    ${GREEN}bun run start${NC}"
echo -e "    ${YELLOW}Tip: Gunakan tmux agar proses tetap berjalan saat koneksi SSH laptop ditutup:${NC}"
echo -e "    ${CYAN}tmux new -s bot 'bun run start'${NC} (detach: Ctrl+B lalu D, attach: tmux attach -t bot)\n"
