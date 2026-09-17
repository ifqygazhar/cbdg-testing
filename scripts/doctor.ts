// ── Cek kesiapan mesin ─────────────────────────────────────────────
// Jawaban atas "sudah siap belum?" tanpa mengorbankan satu akun pun untuk
// mencari tahu. Dijalankan lewat: bun runner.js doctor

import fs from "node:fs";
import path from "node:path";
// Jalur relatif, bukan nama paket: folder scripts/ tidak punya node_modules
// sendiri, jadi "@ifqy/google-oauth" tidak bisa di-resolve dari sini.
import { findInstalledBrowser, launchGoogleOAuthBrowser } from "../packages/google-oauth/src/index.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  GAGAL ${m}`);
const info = (m: string) => console.log(`  ·     ${m}`);

function countEntries(file: string): number {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")).length;
  } catch {
    return 0;
  }
}

export async function main(argv: string[] = []): Promise<number> {
  const cwd = process.cwd();
  const withProxy = !argv.includes("--no-proxy");
  let failures = 0;

  console.log("\ncek kesiapan\n");

  // 1. browser
  const browser = findInstalledBrowser();
  if (browser) ok(`browser: ${browser.name} (${browser.path})`);
  else {
    bad("browser tidak ditemukan — pasang chromium atau google-chrome");
    failures++;
  }

  // 2. layar: kalau mau jalan headed di mesin tanpa monitor, butuh Xvfb
  if (process.platform === "linux") {
    const display = process.env.DISPLAY ?? "";
    const hasXvfb = ["/usr/bin/xvfb-run", "/usr/local/bin/xvfb-run"].some((p) => fs.existsSync(p));
    if (display) ok(`layar: DISPLAY=${display} — mode headed bisa dipakai`);
    else if (hasXvfb) ok("layar: xvfb-run terpasang — mode headed jalan di layar palsu");
    else info("layar: tidak ada, dan xvfb-run belum terpasang — pakai --headless");
  }

  // 3. seed
  const accounts = countEntries(path.join(cwd, "gsuite.txt"));
  if (accounts > 0) ok(`gsuite.txt: ${accounts} akun`);
  else {
    bad("gsuite.txt kosong — isi dulu, satu baris email:password");
    failures++;
  }

  const live = countEntries(path.join(cwd, "proxy-live.txt"));
  const raw = countEntries(path.join(cwd, "proxy.txt"));
  if (live > 0) ok(`proxy-live.txt: ${live} baris`);
  else if (raw > 0) info(`proxy.txt ada ${raw} baris tapi belum dicek — jalankan proxy-check`);
  else info("belum ada proxy — jalankan webshare dulu, atau pakai --no-proxy");

  const cards = countEntries(path.join(cwd, "vcc.txt"));
  info(`vcc.txt: ${cards} kartu (cuma perlu untuk cbdg --full)`);

  // 4. yang paling sering jadi masalah di VPS: browser bisa dipasang tapi
  //    tidak bisa jalan karena shared library atau /dev/shm.
  if (browser) {
    try {
      const handle = await launchGoogleOAuthBrowser({ headless: true, opts: { headless: true } });
      try {
        await handle.page.goto("https://api.ipify.org/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        const ip = (await handle.page.evaluate(() => document.body.innerText)).trim();
        const ua = await handle.page.evaluate(() => navigator.userAgent);
        const wd = await handle.page.evaluate(
          () => (navigator as Navigator & { webdriver?: boolean }).webdriver,
        );
        ok(`browser jalan, keluar lewat ip ${ip}`);
        info(`user agent: ${ua.slice(0, 72)}`);
        if (wd === true) {
          bad("navigator.webdriver = true — stealth tidak aktif");
          failures++;
        } else ok("stealth aktif (navigator.webdriver bukan true)");
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (e) {
      bad(`browser gagal dijalankan: ${(e as Error).message.split(String.fromCharCode(10))[0].slice(0, 120)}`);
      failures++;
    }
  }

  // 5. satu proxy dari kolam, kalau ada
  if (withProxy && live > 0) {
    const first = fs
      .readFileSync(path.join(cwd, "proxy-live.txt"), "utf8")
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (first) {
      try {
        const res = await fetch("https://ipv4.webshare.io/", {
          proxy: first.includes("://") ? first : `http://${first}`,
          signal: AbortSignal.timeout(15_000),
        });
        const exit = (await res.text()).trim();
        ok(`proxy pertama hidup, keluar lewat ip ${exit}`);
      } catch (e) {
        bad(`proxy pertama tidak bisa dipakai: ${(e as Error).message.slice(0, 80)}`);
        failures++;
      }
    }
  }

  console.log(
    failures === 0
      ? "\nsemua siap.\n"
      : `\n${failures} hal perlu dibereskan dulu.\n`,
  );
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => process.exit(code));
}
