#!/usr/bin/env bash
# ==============================================================================
# VPS Setup Script (Ubuntu / Debian)
# Repository: cbdg-credit-automation
#
# Fungsi:
# 1. Update OS & install dependencies sistem (Chromium/Chrome, Xvfb, fonts, dll)
# 2. Install Bun runtime
# 3. Setup Python virtualenv (~/.venvs/camoufox) + Camoufox Anti-Detect Browser
# 4. Setup Cloudflare WARP (Auto Outbound IP saat tanpa proxy + proteksi SSH anti-lockout)
# 5. Generate & Setup SSH Key untuk GitHub (clone private repo)
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
info "1/6. Memperbarui package repository dan menginstal alat dasar..."
$SUDO apt-get update -qq

$SUDO apt-get install -y -qq \
    ca-certificates \
    curl \
    wget \
    git \
    unzip \
    tar \
    build-essential \
    gnupg \
    lsb-release \
    iproute2 \
    iptables \
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
info "2/6. Memeriksa browser Google Chrome / Chromium..."
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
info "3/6. Memeriksa runtime Bun..."
BUN_DIR="$HOME/.bun"
if [ ! -f "$BUN_DIR/bin/bun" ]; then
    info "Menginstal Bun..."
    curl -fsSL https://bun.sh/install | bash
fi

export BUN_INSTALL="$BUN_DIR"
export PATH="$BUN_INSTALL/bin:$PATH"

# Buat symlink ke /usr/local/bin agar langsung aktif di SEMUA shell tanpa perlu relogin/source bashrc
if [ -f "$BUN_DIR/bin/bun" ]; then
    $SUDO ln -sf "$BUN_DIR/bin/bun" /usr/local/bin/bun
    ok "Bun berhasil di-link ke /usr/local/bin/bun"
fi

# Simpan ke .bashrc, .profile, dan /etc/profile.d/bun.sh
for RC_FILE in "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$RC_FILE" ] && ! grep -q 'BUN_INSTALL' "$RC_FILE" 2>/dev/null; then
        cat >> "$RC_FILE" <<'EOF'

# Bun runtime
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
    fi
done

if [ -d "/etc/profile.d" ]; then
    cat <<'EOF' | $SUDO tee /etc/profile.d/bun.sh >/dev/null
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
    $SUDO chmod +x /etc/profile.d/bun.sh 2>/dev/null || true
fi

if command -v bun >/dev/null 2>&1; then
    ok "Bun runtime: $(bun --version)"
else
    err "Gagal menemukan bun setelah instalasi."
    exit 1
fi

# 5. Setup Python Virtualenv & Camoufox
info "4/6. Menyiapkan Python virtual environment & Camoufox anti-bot browser..."
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

# Symlink camoufox ke /usr/local/bin
if [ -f "$VENV_DIR/bin/camoufox" ]; then
    $SUDO ln -sf "$VENV_DIR/bin/camoufox" /usr/local/bin/camoufox 2>/dev/null || true
fi

# Simpan environment CAMOUFOX_PYTHON ke .bashrc dan .profile
for RC_FILE in "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$RC_FILE" ] && ! grep -q 'CAMOUFOX_PYTHON' "$RC_FILE" 2>/dev/null; then
        cat >> "$RC_FILE" <<EOF

# Camoufox Python
export CAMOUFOX_PYTHON="$VENV_DIR/bin/python"
export PATH="$VENV_DIR/bin:\$PATH"
EOF
    fi
done

if [ -f "/etc/environment" ] && ! grep -q 'CAMOUFOX_PYTHON' /etc/environment 2>/dev/null; then
    echo "CAMOUFOX_PYTHON=\"$VENV_DIR/bin/python\"" | $SUDO tee -a /etc/environment >/dev/null 2>&1 || true
fi

export CAMOUFOX_PYTHON="$VENV_DIR/bin/python"
export PATH="$VENV_DIR/bin:$PATH"

ok "Python environment siap di: $VENV_DIR/bin/python"

# 6. Setup Cloudflare WARP (Auto Outbound IP Non-Proxy + Proteksi SSH Anti-Lockout)
info "5/6. Menyiapkan & mengonfigurasi Cloudflare WARP (Outbound IP otomatis jika non-proxy)..."

# 6.1 Deteksi OS dan pasang repository Cloudflare WARP jika belum terpasang
if ! command -v warp-cli >/dev/null 2>&1; then
    info "Mengunduh dan menginstal Cloudflare WARP client..."
    OS_CODENAME="jammy"
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_CODENAME="${VERSION_CODENAME:-}"
    fi
    if [ -z "$OS_CODENAME" ] && command -v lsb_release >/dev/null 2>&1; then
        OS_CODENAME="$(lsb_release -cs 2>/dev/null || echo 'jammy')"
    fi
    case "$OS_CODENAME" in
        focal|jammy|noble|bullseye|bookworm) ;;
        *)
            if [ "${ID:-}" = "debian" ]; then
                OS_CODENAME="bookworm"
            else
                OS_CODENAME="jammy"
            fi
            ;;
    esac

    $SUDO mkdir -p /usr/share/keyrings
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | $SUDO gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg 2>/dev/null || true
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $OS_CODENAME main" | $SUDO tee /etc/apt/sources.list.d/cloudflare-client.list >/dev/null

    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    $SUDO apt-get install -y -qq cloudflare-warp >/dev/null 2>&1 || warn "Gagal memasang cloudflare-warp via apt, silakan cek ketersediaan repo."
fi

# 6.2 Pasang script dan systemd service untuk proteksi SSH policy-based routing (Anti-Lockout)
info "Menerapkan proteksi SSH policy-based routing (mencegah sesi SSH terputus)..."
cat <<'EOF' | $SUDO tee /usr/local/bin/warp-ssh-bypass-apply.sh >/dev/null
#!/usr/bin/env bash
set -euo pipefail

# Cari default gateway dan interface fisik (abaikan warp0 / tun)
DEF_ROUTE=$(ip -4 route show default 2>/dev/null | grep -v -E 'warp0|tun' | head -n1 || true)
if [ -z "$DEF_ROUTE" ]; then
    DEF_ROUTE=$(ip -4 route show 2>/dev/null | grep -E 'default.*(eth|ens|enp|eno|wl)' | head -n1 || true)
fi

MAIN_GW=$(echo "$DEF_ROUTE" | awk '{print $3}')
MAIN_IFACE=$(echo "$DEF_ROUTE" | awk '{print $5}')

if [ -n "$MAIN_GW" ] && [ -n "$MAIN_IFACE" ]; then
    # Daftarkan tabel bypass_ssh jika belum ada
    if [ -f /etc/iproute2/rt_tables ] && ! grep -q 'bypass_ssh' /etc/iproute2/rt_tables 2>/dev/null; then
        echo "200 bypass_ssh" >> /etc/iproute2/rt_tables
    fi

    # Rute default tabel bypass_ssh melalui interface fisik
    ip route replace default via "$MAIN_GW" dev "$MAIN_IFACE" table bypass_ssh 2>/dev/null || true

    # Kumpulkan port SSH (22 dan port dari sshd_config jika ada)
    PORTS="22"
    if [ -f /etc/ssh/sshd_config ]; then
        SSHD_PORTS=$(grep -E '^[# ]*Port ' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' || true)
        for P in $SSHD_PORTS; do
            PORTS="$PORTS $P"
        done
    fi

    # Pasang routing rule untuk port SSH
    for PORT in $PORTS; do
        if ! ip rule show 2>/dev/null | grep -q "sport $PORT.*bypass_ssh"; then
            ip rule add ipproto tcp sport "$PORT" table bypass_ssh priority 100 2>/dev/null || \
            ip rule add sport "$PORT" table bypass_ssh priority 100 2>/dev/null || true
        fi
        if ! ip rule show 2>/dev/null | grep -q "dport $PORT.*bypass_ssh"; then
            ip rule add ipproto tcp dport "$PORT" table bypass_ssh priority 101 2>/dev/null || \
            ip rule add dport "$PORT" table bypass_ssh priority 101 2>/dev/null || true
        fi

        # Mangle mark dengan iptables jika ada
        if command -v iptables >/dev/null 2>&1; then
            iptables -t mangle -C OUTPUT -p tcp --sport "$PORT" -j MARK --set-mark 42 2>/dev/null || \
            iptables -t mangle -A OUTPUT -p tcp --sport "$PORT" -j MARK --set-mark 42 2>/dev/null || true
        fi
    done

    if command -v iptables >/dev/null 2>&1; then
        if ! ip rule show 2>/dev/null | grep -q "fwmark 0x2a.*bypass_ssh"; then
            ip rule add fwmark 42 table bypass_ssh priority 99 2>/dev/null || true
        fi
    fi
fi
EOF

$SUDO chmod +x /usr/local/bin/warp-ssh-bypass-apply.sh
$SUDO /usr/local/bin/warp-ssh-bypass-apply.sh || true

# Daftarkan systemd service agar proteksi SSH selalu aktif otomatis saat boot
cat <<'EOF' | $SUDO tee /etc/systemd/system/warp-ssh-bypass.service >/dev/null
[Unit]
Description=Cloudflare WARP SSH Bypass Policy Routing
Before=network-online.target warp-svc.service
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/warp-ssh-bypass-apply.sh

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload >/dev/null 2>&1 || true
$SUDO systemctl enable warp-ssh-bypass.service >/dev/null 2>&1 || true

# 6.3 Jalankan service warp-svc dan lakukan registrasi
if command -v warp-cli >/dev/null 2>&1; then
    $SUDO systemctl enable --now warp-svc >/dev/null 2>&1 || true

    # Tunggu warp-svc socket siap (maksimal 10 detik)
    for i in {1..10}; do
        if [ -S /var/run/cloudflare-warp/warp-svc.sock ] || warp-cli status >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    # Exclude client IP saat ini di split-tunnel jika sedang login via SSH
    if [ -n "${SSH_CLIENT:-}" ]; then
        CLIENT_IP=$(echo "$SSH_CLIENT" | awk '{print $1}')
        if [ -n "$CLIENT_IP" ]; then
            warp-cli tunnel ip add "$CLIENT_IP" >/dev/null 2>&1 || true
        fi
    fi

    # Registrasi akun WARP jika belum ada
    if ! warp-cli registration show >/dev/null 2>&1; then
        info "Mendaftarkan client Cloudflare WARP..."
        warp-cli --accept-tos registration new >/dev/null 2>&1 || \
        warp-cli registration new >/dev/null 2>&1 || \
        warp-cli --accept-tos register >/dev/null 2>&1 || \
        warp-cli register >/dev/null 2>&1 || true
    fi

    # Atur mode tunnel penuh (warp) agar semua outbound non-proxy memakai IP WARP
    warp-cli mode warp >/dev/null 2>&1 || true

    # Hubungkan ke Cloudflare WARP
    info "Menyambungkan koneksi Cloudflare WARP..."
    warp-cli connect >/dev/null 2>&1 || true
    sleep 3

    # Verifikasi status WARP
    WARP_TRACE=$(curl -s --max-time 6 https://1.1.1.1/cdn-cgi/trace 2>/dev/null || true)
    if echo "$WARP_TRACE" | grep -q 'warp=on'; then
        WARP_IP=$(echo "$WARP_TRACE" | grep '^ip=' | cut -d= -f2 || echo 'Terhubung')
        ok "Cloudflare WARP berhasil aktif! Outbound IP default: $WARP_IP (warp=on)"
    else
        CURRENT_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "Unknown")
        warn "WARP terpasang (IP saat ini: $CURRENT_IP). Jika belum otomatis tersambung, jalankan: warp-on"
    fi

    # 6.4 Buat script utilitas cepat (warp-status, warp-on, warp-off, warp-ip)
    cat <<'EOF' | $SUDO tee /usr/local/bin/warp-status >/dev/null
#!/usr/bin/env bash
echo "=== Cloudflare WARP Status ==="
if command -v warp-cli >/dev/null 2>&1; then
    warp-cli status 2>/dev/null || echo "warp-svc tidak aktif."
else
    echo "warp-cli belum terinstal."
fi
echo ""
echo "=== IP & Network Verification ==="
TRACE=$(curl -s --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null || true)
if [ -n "$TRACE" ]; then
    WARP_VAL=$(echo "$TRACE" | grep '^warp=' | cut -d= -f2 || echo 'off')
    IP_VAL=$(echo "$TRACE" | grep '^ip=' | cut -d= -f2 || echo 'Unknown')
    COLO_VAL=$(echo "$TRACE" | grep '^colo=' | cut -d= -f2 || echo 'Unknown')
    LOC_VAL=$(echo "$TRACE" | grep '^loc=' | cut -d= -f2 || echo 'Unknown')
    echo "Outbound IP : $IP_VAL"
    echo "WARP State  : $WARP_VAL"
    echo "Location    : $LOC_VAL (Datacenter: $COLO_VAL)"
else
    PUB_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "Gagal mengecek IP")
    echo "Outbound IP : $PUB_IP"
    echo "WARP State  : off (Tidak terdeteksi Cloudflare trace)"
fi
EOF

    cat <<'EOF' | $SUDO tee /usr/local/bin/warp-on >/dev/null
#!/usr/bin/env bash
warp-cli connect
sleep 2
warp-status
EOF

    cat <<'EOF' | $SUDO tee /usr/local/bin/warp-off >/dev/null
#!/usr/bin/env bash
warp-cli disconnect
sleep 2
warp-status
EOF

    cat <<'EOF' | $SUDO tee /usr/local/bin/warp-ip >/dev/null
#!/usr/bin/env bash
curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep '^ip=' | cut -d= -f2 || true
echo ""
EOF

    cat <<'EOF' | $SUDO tee /usr/local/bin/warp-switch >/dev/null
#!/usr/bin/env bash
echo "Sedang merefresh identitas & berganti IP WARP baru..."
warp-cli disconnect >/dev/null 2>&1 || true
warp-cli registration delete >/dev/null 2>&1 || true
warp-cli --accept-tos registration new >/dev/null 2>&1 || warp-cli registration new >/dev/null 2>&1 || true
warp-cli mode warp >/dev/null 2>&1 || true
warp-cli connect >/dev/null 2>&1 || true
sleep 3
warp-status
EOF

    cat <<'EOF' | $SUDO tee /usr/local/bin/warp >/dev/null
#!/usr/bin/env bash
if [ -f "./scripts/warp.ts" ]; then
    bun run ./scripts/warp.ts "$@"
elif [ -f "$HOME/cbdg/scripts/warp.ts" ]; then
    bun run "$HOME/cbdg/scripts/warp.ts" "$@"
else
    warp-status
fi
EOF

    $SUDO chmod +x /usr/local/bin/warp-status /usr/local/bin/warp-on /usr/local/bin/warp-off /usr/local/bin/warp-ip /usr/local/bin/warp-switch /usr/local/bin/warp

    # Tambahkan alias ke profile
    for RC_FILE in "$HOME/.bashrc" "$HOME/.profile"; do
        if [ -f "$RC_FILE" ] && ! grep -q 'warp-status' "$RC_FILE" 2>/dev/null; then
            cat >> "$RC_FILE" <<'EOF'

# Cloudflare WARP helper aliases
alias warp-status='/usr/local/bin/warp-status'
alias warp-ip='/usr/local/bin/warp-ip'
alias warp-on='/usr/local/bin/warp-on'
alias warp-off='/usr/local/bin/warp-off'
alias warp-switch='/usr/local/bin/warp-switch'
alias warp='/usr/local/bin/warp'
EOF
        fi
    done

    ok "Perintah praktis WARP siap: warp (TUI), warp-switch, warp-status, warp-ip, warp-on, warp-off"
else
    warn "warp-cli tidak ditemukan, silakan periksa instalasi manual."
fi

# 7. Setup SSH Key untuk GitHub
info "6/6. Menyiapkan SSH Key untuk koneksi ke GitHub..."
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
echo -e "    ${YELLOW}(Jika sesi terminal ini dibuka sebelum setup, jalankan: source ~/.bashrc)${NC}"
echo -e "    ${GREEN}bun install${NC}\n"
echo -e " 4. Menjalankan runner:"
echo -e "    ${GREEN}bun run start${NC}"
echo -e "    ${YELLOW}Tip: Gunakan tmux agar proses tetap berjalan saat koneksi SSH laptop ditutup:${NC}"
echo -e "    ${CYAN}tmux new -s bot 'bun run start'${NC} (detach: Ctrl+B lalu D, attach: tmux attach -t bot)\n"

echo -e "${BOLD}🌐 CLOUDFLARE WARP (OUTBOUND IP OTOMATIS):${NC}"
echo -e " • Saat bot dijalankan ${BOLD}tanpa proxy${NC} (${CYAN}--no-proxy${NC} / direct), otomatis menggunakan IP dari ${GREEN}Cloudflare WARP${NC}."
echo -e " • Saat bot dijalankan ${BOLD}dengan proxy${NC} (${CYAN}--use-proxy${NC}), request otomatis keluar via IP Proxy tersebut."
echo -e " • Dilengkapi ${BOLD}proteksi SSH policy-based routing${NC} (sesi SSH Anda dijamin tidak terputus)."
echo -e " • Perintah cepat WARP:"
echo -e "    - ${CYAN}warp${NC}        : Buka Menu TUI Interaktif (Switch IP, Status, Auto-Loop)"
echo -e "    - ${CYAN}warp-switch${NC} : Ganti ke IP Cloudflare WARP baru secara instan"
echo -e "    - ${CYAN}warp-status${NC} : Cek status WARP & IP outbound aktif"
echo -e "    - ${CYAN}warp-ip${NC}     : Tampilkan IP publik saat ini"
echo -e "    - ${CYAN}warp-on${NC}     : Hubungkan kembali ke Cloudflare WARP"
echo -e "    - ${CYAN}warp-off${NC}    : Putuskan koneksi WARP (kembali ke IP asli VPS)\n"
