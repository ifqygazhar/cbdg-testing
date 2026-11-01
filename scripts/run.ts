#!/usr/bin/env bun
// ── Interactive launcher ───────────────────────────────────────────
// One entry point for every app in the repo: pick what to run, how far to take
// it, how fast, and whether to spread accounts over the harvested proxies.
// Everything it can do is also reachable by typing the flags directly; the
// command it is about to run is printed so you can copy it next time.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { select, confirm, askNumber, askText, releaseStdin, ui, Cancelled } from "./prompt.js";
import {
  APP_ENTRY,
  IS_TOOL,
  PROXY_CAPABLE,
  ENGINE_CAPABLE,
  googleDirectEnabled,
  proxyReuseEnabled,
  buildArgs,
  commandLine,
  readSeeds,
  warningsFor,
  getRemainingAccountsForApp,
  type AppName,
  type CbdgMode,
  type Pace,
  type BrowserEngine,
  type RunPlan,
} from "./plan.js";


function banner(seeds: ReturnType<typeof readSeeds>): void {
  const line = (label: string, n: number, file: string) =>
    `  ${label.padEnd(9)} ${String(n).padStart(3)}  ${ui.dim(file)}`;
  console.log(`
${ui.bold("automation runner")}
${line("akun", seeds.accounts, "gsuite.txt")}
${line("proxy", seeds.proxies, "proxy.txt")}
${line("· hidup", seeds.live, "proxy-live.txt")}
${line("· alamat", seeds.liveAddresses, "IP unik — batas 1 akun 1 IP")}
${line("kartu", seeds.cards, "vcc.txt")}`);
}

async function askPlan(): Promise<RunPlan> {
  const seeds = readSeeds();
  banner(seeds);

  const app = await select<AppName>("Mau jalankan yang mana?", [
    { value: "webshare", label: "webshare", hint: "daftar via Google → panen proxy gratis ke proxy.txt" },
    { value: "proxy-check", label: "cek proxy", hint: "proxy.txt → uji hidup/mati / format & dedupe unik" },
    { value: "key-checker", label: "cek apikey", hint: "uji status valid / kuota / rate limit API key berbagai provider" },
    { value: "key-dedupe", label: "format & dedupe apikey", hint: "bersihkan duplikat / format ulang (plain/akun) API key semua provider" },
    { value: "crusoe", label: "crusoe", hint: "daftar Crusoe → bonus $5 + API key ke apikey.txt" },
    { value: "fastrouter", label: "fastrouter", hint: "daftar FastRouter → kredit $1 + API key ke apikey-fastrouter" },
    { value: "cbdg", label: "cbdg", hint: "daftar CodeBuddy → kredit new-user (+ VCC opsional)" },
    { value: "tokenharbor", label: "tokenharbor", hint: "daftar TokenHarbor (TempMail / GSuite) → API key ke apikey-tokenharbor.txt" },
    { value: "groqcloud", label: "groqcloud", hint: "daftar GroqCloud (TempMail + Turnstile) → API key ke apikey-groqcloud.txt" },
    { value: "llm7io", label: "llm7io", hint: "daftar LLM7.io (TempMail / GSuite) → API key ke apikey-llm7io.txt" },
    { value: "inferbase", label: "inferbase", hint: "daftar Inferbase (TempMail / Google OAuth) → API key ke apikey-inferbase.txt" },
    { value: "openrouter", label: "openrouter", hint: "daftar OpenRouter (TempMail / Google OAuth) → API key ke apikey-openrouter.txt" },
    { value: "composite", label: "composite", hint: "daftar Composite Lucidity (TempMail + Turnstile) → API key ke apikey-composite.txt" },
    { value: "inferencedahl", label: "inferencedahl", hint: "daftar Inference Dahl Global (Auto Username + Allocate 100M) → API key ke apikey-inferencedahl.txt" },
    { value: "zromoonmath", label: "zromoonmath", hint: "daftar Zro MoonMath (TempMail / Google OAuth) → API key ke apikey-zro.txt" },
  ]);

  if (IS_TOOL[app]) {
    if (app === "key-dedupe") {
      const dedupeAction = await select<"dedupe" | "interactive">("Pilih aksi untuk pembersih API key:", [
        {
          value: "dedupe",
          label: "Format & Hapus Duplikat Cepat (Quick Clean & Format)",
          hint: "pilih target provider/file, format output, dan bersihkan duplikat secara langsung",
        },
        {
          value: "interactive",
          label: "Buka Menu Interaktif Penuh (Interactive Suite)",
          hint: "jalankan TUI mandiri dengan ringkasan statistik duplikasi mendalam per file",
        },
      ]);

      if (dedupeAction === "interactive") {
        return {
          app,
          pace: "human",
          headless: false,
          retryFailed: false,
          dryRun: false,
          delaySec: 0,
          workers: 1,
        };
      }

      const targetChoice = await select<string>("Pilih target file API key yang ingin diformat & dibersihkan:", [
        { value: "all", label: "🌟 Semua File Sekaligus (Workspace-wide)", hint: "bersihkan seluruh file API key di proyek" },
        { value: "inferencedahl", label: "Inference Dahl", hint: "apikey-inferencedahl.txt, akun-result, dataset" },
        { value: "tokenharbor", label: "TokenHarbor", hint: "apikey-tokenharbor.txt, apikey-unli.txt, good, ratelimit, dll." },
        { value: "llm7io", label: "LLM7.io", hint: "apikey-llm7io.txt, apikey-good-llm7io.txt, vps" },
        { value: "inferbase", label: "Inferbase", hint: "apikey-inferbase.txt, dataset" },
        { value: "groqcloud", label: "GroqCloud", hint: "apikey-groqcloud.txt, dataset" },
        { value: "fastrouter", label: "FastRouter", hint: "apikey-fastrouter.txt, dataset" },
        { value: "crusoe", label: "Crusoe Cloud", hint: "apikey.txt, keys.txt" },
        { value: "custom", label: "✏️ Ketik Path File Kustom...", hint: "masukkan path file spesifik secara manual" },
      ]);

      let finalTarget = targetChoice;
      if (targetChoice === "custom") {
        finalTarget = await askText("Masukkan path file API key:", "apikey-inferencedahl.txt");
      }

      const formatStyle = await select<"smart" | "plain" | "account">("Format penulisan output API key?", [
        {
          value: "smart",
          label: "Format Asli Bersih (Smart / Raw - Default)",
          hint: "pertahankan kredensial akun jika ada, hapus whitespace & duplikat",
        },
        {
          value: "plain",
          label: "Hanya Plain Key Murni (Ekstrak Key Saja)",
          hint: "ekstrak hanya string API key per baris (buang email/pass/json)",
        },
        {
          value: "account",
          label: "Format Akun Standar (email:password:key / user:key)",
          hint: "seragamkan baris yang memiliki data akun ke format email:password:key",
        },
      ]);

      const strategy = await select<"smart" | "first" | "exact">("Strategi deduplikasi?", [
        {
          value: "smart",
          label: "Smart (Prioritaskan format lengkap / akun)",
          hint: "jika ada baris plain dan baris akun untuk key yang sama, simpan baris akun",
        },
        {
          value: "first",
          label: "First-Seen (Pertahankan baris pertama)",
          hint: "pertahankan kemunculan baris pertama yang ditemukan, buang setelahnya",
        },
        {
          value: "exact",
          label: "Exact Line (Sama persis)",
          hint: "hanya buang baris yang 100% sama persis kata demi kata",
        },
      ]);

      const doBackup = await confirm("Buat file cadangan backup (.bak) sebelum overwrite?", true);

      return {
        app,
        pace: "human",
        headless: false,
        retryFailed: false,
        dryRun: false,
        delaySec: 0,
        workers: 1,
        keyDedupeTarget: finalTarget,
        keyFormatStyle: formatStyle,
        keyDedupeStrategy: strategy,
        keyDedupeBackup: doBackup,
      };
    }

    if (app === "key-checker") {
      return {
        app,
        pace: "human",
        headless: false,
        retryFailed: false,
        dryRun: false,
        delaySec: 0,
        workers: 1,
      };
    }
    const proxyAction = await select<"check" | "dedupe">("Pilih aksi untuk proxy checker:", [
      {
        value: "check",
        label: "Uji hidup/mati (Liveness Scan)",
        hint: "cek proxy.txt satu per satu → tulis proxy aktif ke proxy-live.txt",
      },
      {
        value: "dedupe",
        label: "Format & Hapus Duplikat (Deduplicate)",
        hint: "format & hilangkan semua proxy duplikat agar tersisa yang unik saja",
      },
    ]);

    if (proxyAction === "dedupe") {
      const targetFile = await select<string>("File mana yang ingin diformat & dibersihkan duplikatnya?", [
        { value: "all", label: "Semua (proxy.txt dan proxy-live.txt)", hint: "bersihkan duplikat di kedua pool sekaligus (disarankan)" },
        { value: "proxy.txt", label: "proxy.txt saja", hint: "pool mentah hasil panen webshare" },
        { value: "proxy-live.txt", label: "proxy-live.txt saja", hint: "pool proxy live yang siap pakai" },
      ]);
      const styleChoice = await select<"raw" | "url" | "colon">("Format penulisan proxy output?", [
        { value: "raw", label: "Format Asli Bersih (Default)", hint: "pertahankan format asli yang sudah valid tanpa duplikat" },
        { value: "url", label: "Format URL Standar", hint: "format ke protocol://[user:pass@]host:port standar" },
        { value: "colon", label: "Format Titik Dua (host:port:user:pass)", hint: "format ke host:port[:user:pass] tanpa scheme" },
      ]);
      return {
        app,
        pace: "human",
        headless: false,
        retryFailed: false,
        dryRun: false,
        delaySec: 0,
        workers: 1,
        proxyDedupe: true,
        proxyDedupeTarget: targetFile,
        proxyFormatStyle: styleChoice,
      };
    }

    const targetSite = await select<string>("Uji untuk target website apa?", [
      { value: "", label: "Umum (semua situs)", hint: "uji liveness & IP echo via ipv4.webshare.io (default)" },
      { value: "https://dash.llm7.io", label: "LLM7.io", hint: "uji liveness + akses langsung ke dash.llm7.io" },
      { value: "https://console.groq.com", label: "GroqCloud", hint: "uji liveness + akses langsung ke console.groq.com" },
      { value: "https://tokenharbor.ai", label: "TokenHarbor", hint: "uji liveness + akses langsung ke tokenharbor.ai" },
      { value: "https://fastrouter.ai", label: "FastRouter", hint: "uji liveness + akses langsung ke fastrouter.ai" },
      { value: "https://console.crusoecloud.com", label: "Crusoe", hint: "uji liveness + akses langsung ke crusoecloud.com" },
      { value: "https://inferbase.ai", label: "Inferbase", hint: "uji liveness + akses langsung ke inferbase.ai" },
      { value: "https://www.codebuddy.ca", label: "CodeBuddy", hint: "uji liveness + akses langsung ke codebuddy.ca" },
    ]);
    const appendMode = await select<boolean>("Mode penulisan ke proxy-live.txt?", [
      { value: false, label: "Tulis real-time baru (default)", hint: "langsung tulis tiap proxy hidup saat ditemukan, timpa file saat yang pertama lolos" },
      { value: true, label: "Append ke daftar yang sudah ada", hint: "tambahkan proxy baru ke proxy-live.txt yang sudah ada tanpa menghapus yang lama" },
    ]);
    return {
      app,
      pace: "human",
      headless: false,
      retryFailed: false,
      dryRun: false,
      delaySec: 0,
      workers: 1,
      proxyTarget: targetSite || undefined,
      proxyAppend: appendMode || undefined,
    };
  }

  let mode: CbdgMode | undefined;
  if (app === "cbdg") {
    mode = await select<CbdgMode>("Sampai mana?", [
      { value: "signup", label: "Signup saja", hint: "berhenti setelah daftar, tanpa VCC" },
      { value: "full", label: "Full", hint: `lanjut isi kartu + 3DS + trial (butuh vcc.txt: ${seeds.cards})` },
    ]);
  }

  let engine: BrowserEngine | undefined;
  if (ENGINE_CAPABLE.includes(app)) {
    engine = await select<BrowserEngine>("Browser engine?", [
      {
        value: "python",
        label: "Python (Camoufox / Firefox)",
        hint: "Bypass Cloudflare Turnstile & anti-bot otomatis (disarankan)",
      },
      {
        value: "bun",
        label: "Bun (Puppeteer / Chromium)",
        hint: "Engine Chromium bawaan",
      },
    ], app === "fastrouter" || app === "tokenharbor" || app === "groqcloud" || app === "llm7io" || app === "webshare" || app === "inferbase" || app === "openrouter" || app === "composite" || app === "inferencedahl" || app === "zromoonmath" ? 0 : 1);
  }

  let useProxy: boolean | undefined;

  let reuseProxy: boolean | undefined;
  let googleDirect: boolean | undefined;
  if (PROXY_CAPABLE.includes(app)) {
    const pool =
      seeds.live > 0
        ? `proxy-live.txt (${seeds.liveAddresses} alamat unik)`
        : `proxy.txt (${seeds.proxies} baris, belum dicek)`;
    useProxy = await select<boolean>("Pakai proxy?", [
      { value: true, label: "Dengan proxy", hint: pool },
      { value: false, label: "Tanpa proxy", hint: "semua akun dari IP mesin ini" },
    ], seeds.live > 0 || seeds.proxies > 0 ? 0 : 1);

    if (useProxy) {
      const defReuse = proxyReuseEnabled();
      reuseProxy = await select<boolean>("Alokasi proxy?", [
        {
          value: false,
          label: "1 akun 1 alamat unik (default)",
          hint: "tahan akun jika kehabisan IP baru (aman untuk risk engine)",
        },
        {
          value: true,
          label: "Reuse / rotasi proxy yang ada",
          hint:
            seeds.accounts > seeds.liveAddresses && seeds.liveAddresses > 0
              ? `putar ulang dari awal (${seeds.accounts} akun, ${seeds.liveAddresses} IP)`
              : "putar ulang dari awal jika jumlah akun melebihi proxy",
        },
      ], defReuse ? 1 : 0);
    }
    // Reads the same knob the apps read, so the review and the printed command
    // tell the truth even when .env overrides the default.
    googleDirect = useProxy ? googleDirectEnabled() : undefined;
  }

  const pace = await select<Pace>("Kecepatan?", [
    { value: "human", label: "human", hint: "default, cadence asli" },
    { value: "fast", label: "fast", hint: "tanpa menunggu yang percuma, ketikan tetap manusiawi" },
    { value: "careful", label: "careful", hint: "lebih pelan dari manusia, buat risk engine galak" },
  ]);

  let reEnableFree = false;
  let reverifyEmail = false;
  if (app === "tokenharbor") {
    let badCount = 0;
    const badPath = resolve(process.cwd(), "akun-bad-tokenharbor.txt");
    if (existsSync(badPath)) {
      badCount = readFileSync(badPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    }

    let needVerifCount = 0;
    const needVerifKeyPath = resolve(process.cwd(), "apikey-need-verif-tokenharbor.txt");
    const needVerifAccPath = resolve(process.cwd(), "akun-need-verif-tokenharbor.txt");
    if (existsSync(needVerifKeyPath)) {
      needVerifCount = readFileSync(needVerifKeyPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    } else if (existsSync(needVerifAccPath)) {
      needVerifCount = readFileSync(needVerifAccPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    }

    const harborAction = await select<"signup" | "reenable" | "reverify">(
      "Pilih tindakan untuk TokenHarbor?",
      [
        {
          value: "signup",
          label: "Pendaftaran Akun Baru (Signup)",
          hint: "Daftar akun baru via Google OAuth atau TempMail",
        },
        {
          value: "reenable",
          label: "Re-enable Free Models (Aktifkan Ulang)",
          hint: `Login & klik enable free models di dashboard (${badCount} akun di akun-bad-tokenharbor.txt)`,
        },
        {
          value: "reverify",
          label: "Re-verifikasi Email (Verifikasi Ulang Akun/Key)",
          hint: `Login & minta kirim ulang email verifikasi di dashboard (${needVerifCount} akun di apikey-need-verif-tokenharbor.txt)`,
        },
      ],
      0,
    );
    if (harborAction === "reenable") {
      reEnableFree = true;
    } else if (harborAction === "reverify") {
      reverifyEmail = true;
    }
  }

  let authMethod: "google" | "tempmail" | undefined;
  if (app === "composite") {
    authMethod = "tempmail";
  } else if (!reEnableFree && !reverifyEmail && (app === "fastrouter" || app === "tokenharbor" || app === "llm7io" || app === "inferbase" || app === "openrouter" || app === "zromoonmath")) {
    authMethod = await select<"tempmail" | "google">(
      `Metode pendaftaran ${app === "tokenharbor" ? "TokenHarbor" : app === "llm7io" ? "LLM7.io" : app === "inferbase" ? "Inferbase" : app === "openrouter" ? "OpenRouter" : app === "zromoonmath" ? "Zro MoonMath" : "FastRouter"}?`,
      [
        {
          value: "google",
          label: "Google OAuth (GSuite)",
          hint: `daftar via akun Google (butuh gsuite.txt: ${seeds.accounts} akun)${app === "llm7io" ? " — direkomendasikan karena domain bebas banned" : ""}`,
        },
        {
          value: "tempmail",
          label: "TempMail (TempMail-Pro)",
          hint: "otomatis buat email & verif link / OTP",
        },
      ],
      app === "inferbase" || app === "openrouter" || app === "zromoonmath" ? 1 : (seeds.accounts > 0 ? 0 : 1),
    );
  }

  let domain: string | undefined;
  let gsuiteMode: "create_new_key" | "skip_existing" | "fetch_existing" | undefined;
  if (!reEnableFree && !reverifyEmail && app === "tokenharbor" && authMethod === "google") {
    gsuiteMode = await select<"create_new_key" | "skip_existing" | "fetch_existing">(
      "Strategi untuk akun GSuite TokenHarbor:",
      [
        {
          value: "create_new_key",
          label: "Daftarkan ulang & buat API key baru (Default)",
          hint: "Skip akun di akun-result-tokenharbor.txt; jika akun terdaftar di server tapi belum ada di file hasil, buatkan API key baru",
        },
        {
          value: "fetch_existing",
          label: "Ambil/buat API key untuk akun ALREADY_REGISTERED (Recovery)",
          hint: "Login akun-akun yang berstatus ALREADY_REGISTERED dan buatkan API key baru via + New key",
        },
        {
          value: "skip_existing",
          label: "Skip jika sudah terdaftar / sudah punya key / terverifikasi",
          hint: "Langsung skip akun yang sudah di akun-result-tokenharbor.txt (tanpa login ulang); akun belum tercatat dicek ke server & dilewati jika sudah ada",
        },
      ],
      0,
    );
  }
  let limit: number | undefined;
  if (reEnableFree) {
    const badPath = resolve(process.cwd(), "akun-bad-tokenharbor.txt");
    let badCount = 0;
    if (existsSync(badPath)) {
      badCount = readFileSync(badPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    }
    const defaultLimit = badCount > 0 ? badCount : 1;
    limit = await askNumber(
      `Berapa banyak akun yang ingin diaktifkan ulang? (${badCount} akun tersisa di akun-bad-tokenharbor.txt)`,
      defaultLimit,
      " akun",
    );
  } else if (reverifyEmail) {
    let needVerifCount = 0;
    const needVerifKeyPath = resolve(process.cwd(), "apikey-need-verif-tokenharbor.txt");
    const needVerifAccPath = resolve(process.cwd(), "akun-need-verif-tokenharbor.txt");
    if (existsSync(needVerifKeyPath)) {
      needVerifCount = readFileSync(needVerifKeyPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    } else if (existsSync(needVerifAccPath)) {
      needVerifCount = readFileSync(needVerifAccPath, "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#")).length;
    }
    const defaultLimit = needVerifCount > 0 ? needVerifCount : 1;
    limit = await askNumber(
      `Berapa banyak akun yang ingin diverifikasi ulang? (${needVerifCount} akun tersisa di apikey-need-verif-tokenharbor.txt)`,
      defaultLimit,
      " akun",
    );
  } else if (app === "groqcloud" || app === "composite" || ((app === "tokenharbor" || app === "fastrouter" || app === "llm7io" || app === "inferbase" || app === "openrouter" || app === "zromoonmath") && authMethod === "tempmail")) {
    domain = await select<string>(
      app === "llm7io"
        ? "Domain TempMail? (Catatan: LLM7.io memblokir ifqy.net, meongtopup.my.id, huzt.my.id)"
        : "Domain TempMail?",
      app === "llm7io"
        ? [
            { value: "custom", label: "Ketik domain kustom... (Disarankan)", hint: "gunakan domain fresh yang belum diblokir LLM7.io" },
            { value: "ifqy.net", label: "ifqy.net (Peringatan: Diblokir LLM7.io)", hint: "domain utama — diblokir oleh anti-abuse LLM7.io (HTTP 403)" },
            { value: "meongtopup.my.id", label: "meongtopup.my.id (Peringatan: Diblokir LLM7.io)", hint: "domain alternatif 1 — diblokir LLM7.io" },
            { value: "huzt.my.id", label: "huzt.my.id (Peringatan: Diblokir LLM7.io)", hint: "domain alternatif 2 — diblokir LLM7.io" },
          ]
        : [
            { value: "ifqy.net", label: "ifqy.net", hint: "domain utama TempMail-Pro (default)" },
            { value: "meongtopup.my.id", label: "meongtopup.my.id", hint: "domain alternatif 1" },
            { value: "huzt.my.id", label: "huzt.my.id", hint: "domain alternatif 2" },
            { value: "custom", label: "Ketik domain kustom...", hint: "masukkan domain email lainnya" },
          ],
    );
    if (domain === "custom") {
      domain = await askText("Masukkan domain email kustom", app === "llm7io" ? "" : "ifqy.net");
    }
    if (domain && domain.startsWith("temp.")) {
      domain = domain.slice(5);
    }
    limit = await askNumber("Berapa banyak akun yang ingin dibuat?", 5, " akun");
  } else if (app === "inferencedahl") {
    limit = await askNumber("Berapa banyak akun yang ingin dibuat?", 5, " akun");
  } else if ((app === "tokenharbor" || app === "fastrouter" || app === "cbdg" || app === "crusoe" || app === "llm7io" || app === "inferbase" || app === "openrouter" || app === "zromoonmath") && (authMethod === "google" || app === "cbdg" || app === "crusoe")) {
    const requireKey = app === "tokenharbor" && (gsuiteMode === "fetch_existing" || gsuiteMode === "create_new_key");
    const rem = getRemainingAccountsForApp(app, undefined, requireKey);
    if (rem.completed > 0) {
      console.log(
        ui.cyan(
          `\n  · ${rem.completed} akun dari ${rem.total} sudah selesai dibuat sebelumnya (${rem.remaining} akun tersisa)`,
        ),
      );
    }
    const defaultLimit = rem.remaining > 0 ? rem.remaining : (seeds.accounts || 1);
    const hint = rem.completed > 0 ? `sisa ${rem.remaining} akun dari ${rem.total}` : `${seeds.accounts || 1} akun`;
    limit = await askNumber(`Berapa banyak akun yang ingin dibuat? (${hint})`, defaultLimit, " akun");
    if (rem.remaining > 0 && limit > rem.remaining) {
      console.log(
        ui.yellow(
          `  ! Input ${limit} akun melebihi ${rem.remaining} akun yang tersisa. Target otomatis dibatasi maks ${rem.remaining} akun agar akun yang sudah selesai tidak diulang.`,
        ),
      );
      limit = rem.remaining;
    }
  }

  const delaySec = await askNumber("Jeda antar akun", 60, " detik");
  const workers = await askNumber("Jumlah worker paralel", 1);
  const retryFailed = (reEnableFree || reverifyEmail) ? false : await confirm("Ulangi akun yang tercatat gagal?", false);
  const headless = await confirm("Headless? (captcha/3DS tidak bisa manual)", false);
  const dryRun = await confirm("Dry-run dulu? (validasi saja, tanpa browser)", false);

  return { app, mode, engine, authMethod, gsuiteMode, useProxy, reuseProxy, googleDirect, pace, delaySec, workers, retryFailed, headless, dryRun, limit, domain, reEnableFree, reverifyEmail };
}

function review(plan: RunPlan): void {
  const seeds = readSeeds();
  if (IS_TOOL[plan.app]) {
    const toolRows: Array<[string, string]> = [["app", plan.app]];
    if (plan.app === "key-dedupe") {
      if (plan.keyDedupeTarget) {
        toolRows.push(["target", plan.keyDedupeTarget === "all" ? "semua file API key" : plan.keyDedupeTarget]);
      }
      if (plan.keyFormatStyle) {
        toolRows.push(["format", plan.keyFormatStyle === "plain" ? "plain API key murni" : plan.keyFormatStyle === "account" ? "format akun lengkap" : "asli bersih (smart)"]);
      }
      if (plan.keyDedupeStrategy) {
        toolRows.push(["strategi", plan.keyDedupeStrategy]);
      }
      if (plan.keyDedupeBackup !== undefined) {
        toolRows.push(["backup", plan.keyDedupeBackup ? "buat .bak" : "tanpa backup"]);
      }
    } else if (plan.app === "proxy-check") {
      if (plan.proxyDedupe) {
        toolRows.push(["aksi", "format & dedupe"]);
        toolRows.push(["target", plan.proxyDedupeTarget || "proxy.txt"]);
        toolRows.push(["format", plan.proxyFormatStyle || "raw"]);
      } else {
        toolRows.push(["target", plan.proxyTarget || "umum (ipv4.webshare.io)"]);
        toolRows.push(["mode", plan.proxyAppend ? "append" : "tulis baru"]);
      }
    }
    console.log(`\n${ui.bold("Rencana")}`);
    for (const [k, v] of toolRows) console.log(`  ${ui.dim(k.padEnd(8))} ${v}`);
    const toolWarnings = warningsFor(plan, seeds);
    for (const w of toolWarnings) console.log(`  ${ui.yellow("!")} ${w}`);
    console.log(`\n${ui.dim("perintah:")} ${ui.cyan(commandLine(plan))}`);
    return;
  }
  const rows: Array<[string, string]> = [
    ["app", plan.app],
    ...(plan.reverifyEmail ? ([["tindakan", "Re-verifikasi Email (apikey-need-verif-tokenharbor.txt)"]] as Array<[string, string]>) : []),
    ...(plan.reEnableFree ? ([["tindakan", "Re-enable Free Models (akun-bad-tokenharbor.txt)"]] as Array<[string, string]>) : []),
    ...(plan.engine
      ? ([
          [
            "engine",
            plan.engine === "python"
              ? "Python (Camoufox / Firefox) - Anti-Turnstile"
              : "Bun (Puppeteer / Chromium)",
          ],
        ] as Array<[string, string]>)
      : []),
    ...(plan.domain ? ([["domain", `@${plan.domain}`]] as Array<[string, string]>) : []),
    ...(plan.authMethod ? ([["auth", plan.authMethod === "tempmail" ? "TempMail (verif OTP)" : "Google OAuth"]] as Array<[string, string]>) : []),
    ...(plan.gsuiteMode
      ? ([
          [
            "strategi",
            plan.gsuiteMode === "fetch_existing"
              ? "ambil/buat API key baru untuk akun ALREADY_REGISTERED"
              : plan.gsuiteMode === "skip_existing"
              ? "skip jika sudah terdaftar / sudah punya key / terverifikasi"
              : "daftarkan ulang & buat key baru jika belum di akun-result",
          ],
        ] as Array<[string, string]>)
      : []),
    ...(plan.mode ? ([["mode", plan.mode === "signup" ? "signup saja" : "full (VCC)"]] as Array<[string, string]>) : []),

    ...(plan.useProxy === undefined
      ? []
      : ([
          [
            "proxy",
            plan.useProxy
              ? seeds.live > 0
                ? `proxy-live.txt (${seeds.liveAddresses} alamat unik)`
                : `proxy.txt (${seeds.proxies} baris, belum dicek)`
              : "tanpa proxy",
          ],
        ] as Array<[string, string]>)),
    ...(plan.useProxy
      ? ([
          [
            "alokasi",
            plan.reuseProxy
              ? "reuse / rotasi (putar ulang jika habis)"
              : "1 akun 1 alamat unik",
          ],
        ] as Array<[string, string]>)
      : []),
    ...(plan.useProxy
      ? ([["google", plan.googleDirect === false ? "lewat proxy" : "langsung (hindari captcha)"]] as Array<[string, string]>)
      : []),
    ["pace", plan.pace],
    ...(plan.limit
      ? ([
          [
            "target",
            plan.reverifyEmail
              ? `${plan.limit} akun (dari apikey-need-verif-tokenharbor.txt)`
              : plan.reEnableFree
              ? `${plan.limit} akun (dari akun-bad-tokenharbor.txt)`
              : plan.authMethod === "google"
              ? `${plan.limit} akun (dari sisa akun yang belum dibuat)`
              : `${plan.limit} akun`,
          ],
        ] as Array<[string, string]>)
      : []),
    ["jeda", `${plan.delaySec}s`],
    ["worker", String(plan.workers)],
    ["browser", plan.headless ? "headless" : "headed"],
    ...(plan.retryFailed ? ([["retry", "akun gagal ikut diproses"]] as Array<[string, string]>) : []),
    ...(plan.dryRun ? ([["dry-run", "tanpa browser"]] as Array<[string, string]>) : []),
  ];
  console.log(`\n${ui.bold("Rencana")}`);
  for (const [k, v] of rows) console.log(`  ${ui.dim(k.padEnd(8))} ${v}`);

  const warnings = warningsFor(plan, seeds);
  if (warnings.length) {
    console.log(`\n${ui.yellow("Perhatian")}`);
    for (const w of warnings) console.log(`  ${ui.yellow("!")} ${w}`);
  }
  console.log(`\n${ui.dim("perintah:")} ${ui.cyan(commandLine(plan))}`);
}

async function main(): Promise<void> {
  const plan = await askPlan();
  review(plan);
  if (!(await confirm("Jalankan sekarang?", true))) {
    console.log(ui.dim("\ndibatalkan — perintah di atas bisa dipakai langsung kapan saja."));
    return;
  }

  // Hand the terminal to the child: it needs stdin for a headed run, and our
  // reader would otherwise keep swallowing keys.
  releaseStdin();
  console.log("");
  const proc = Bun.spawn(["bun", "run", APP_ENTRY[plan.app], ...buildArgs(plan)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  const code = await proc.exited;
  console.log(
    code === 0
      ? `\n${ui.green("selesai")} ${ui.dim(`(${plan.app})`)}`
      : `\n${ui.red(`berhenti dengan kode ${code}`)} ${ui.dim(`(${plan.app})`)}`,
  );
  process.exit(code);
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof Cancelled) {
      console.log(ui.dim("\ndibatalkan."));
      process.exit(130);
    }
    console.error(ui.red(`[runner] ${(e as Error).message}`));
    process.exit(1);
  });
}
