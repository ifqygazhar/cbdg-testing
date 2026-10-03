# Menjalankan bundle ini

```bash
bun install                       # sekali saja: 3 paket puppeteer
bun runner.js doctor              # cek browser, seed dan proxy
bun runner.js webshare --headless --fast --delay 60
bun runner.js proxy-check
bun runner.js crusoe --headless --fast --delay 60
bun runner.js fastrouter --headless --fast --delay 60
bun runner.js tokenharbor --headless --fast --delay 60
bun runner.js cbdg --headless --signup-only --with-proxy --delay 60
```

Butuh `gsuite.txt` di folder ini. `proxy-live.txt` dan `vcc.txt` opsional.
Browser: chromium atau google-chrome harus terpasang di mesin ini.

Supaya tetap jalan setelah ssh diputus, pakai `./run.sh` dari bootstrap.
