#!/usr/bin/env bun
// ── Proxy liveness check ───────────────────────────────────────────
// Reads the harvested pool, asks an IP echo through each proxy, and writes the
// ones that answered with somebody else's address to proxy-live.txt. The apps
// read that file, so a dead webshare proxy never costs an account.

import fs from "node:fs";
import path from "node:path";
import {
  checkSocks,
  dedupeAndFormatProxies,
  judge,
  mask,
  parseProxyFile,
  pool,
  readExitIp,
  sortByLatency,
  summarise,
  type CheckResult,
  type ProxyEntry,
  type ProxyFormatStyle,
} from "./proxy-lib.js";
import { ui } from "./prompt.js";

export interface CheckOptions {
  input: string;
  output: string;
  deadFile?: string;
  url: string;
  target?: string;
  timeoutMs: number;
  concurrency: number;
  force: boolean;
  append: boolean;
  skipExisting: boolean;
  dedupe: boolean;
  dedupeAll: boolean;
  dedupeFirst: boolean;
  style: ProxyFormatStyle;
  mode: "endpoint" | "exact";
  backup: boolean;
}

export function parseArgs(argv: string[], cwd = process.cwd()): CheckOptions {
  const o: CheckOptions = {
    input: path.resolve(cwd, "proxy.txt"),
    output: path.resolve(cwd, "proxy-live.txt"),
    url: process.env.PROXY_CHECK_URL || "https://ipv4.webshare.io/",
    target: process.env.PROXY_CHECK_TARGET,
    timeoutMs: Number(process.env.PROXY_CHECK_TIMEOUT_SEC || 12) * 1000,
    concurrency: Number(process.env.PROXY_CHECK_CONCURRENCY || 10),
    force: false,
    append: false,
    skipExisting: false,
    dedupe: false,
    dedupeAll: false,
    dedupeFirst: false,
    style: "raw",
    mode: "endpoint",
    backup: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--in") o.input = path.resolve(cwd, next());
    else if (a === "--out") o.output = path.resolve(cwd, next());
    else if (a === "--dead") o.deadFile = path.resolve(cwd, next());
    else if (a === "--url") o.url = next();
    else if (a === "--target" || a === "-t") o.target = next();
    else if (a === "--timeout") o.timeoutMs = Number(next()) * 1000;
    else if (a === "--concurrency" || a === "-c") o.concurrency = Number(next());
    else if (a === "--force") o.force = true;
    else if (a === "--append" || a === "-a") o.append = true;
    else if (a === "--skip-existing" || a === "-s") o.skipExisting = true;
    else if (a === "--dedupe" || a === "--unique" || a === "--clean" || a === "--format") o.dedupe = true;
    else if (a === "--all" || a === "--dedupe-all") { o.dedupe = true; o.dedupeAll = true; }
    else if (a === "--dedupe-first") o.dedupeFirst = true;
    else if (a === "--backup") o.backup = true;
    else if (a === "--style") {
      const s = next()?.toLowerCase();
      if (s === "url" || s === "colon" || s === "raw") o.style = s as ProxyFormatStyle;
    }
    else if (a === "--by" || a === "--mode") {
      const m = next()?.toLowerCase();
      if (m === "exact" || m === "endpoint") o.mode = m;
    }
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: bun run proxy-check [--in FILE] [--out FILE] [--dead FILE]",
          "                           [--timeout SEC] [-c N] [--url URL] [--target URL] [--append] [--skip-existing] [--force]",
          "                           [--dedupe] [--all] [--style raw|url|colon] [--by endpoint|exact] [--backup] [--dedupe-first]",
          "",
          "  Membaca proxy.txt, mengecek satu per satu, dan langsung menulis yang",
          "  hidup ke proxy-live.txt secara real-time (tanpa perlu menunggu scan beres).",
          "",
          "  Fitur Format & Deduplikasi (Hilangkan Duplikat):",
          "  --dedupe, --unique  format & hilangkan semua duplikat agar tersisa proxy yang unik",
          "  --all, --dedupe-all bersihkan duplikat pada proxy.txt dan proxy-live.txt sekaligus",
          "  --style STYLE       format baris: raw (default), url (standard protocol://...), colon (host:port[:user:pass])",
          "  --by MODE           kriteria duplikat: endpoint (IP:port sama, default) atau exact (string baris persis)",
          "  --backup            buat cadangan file .bak sebelum menimpa file asli",
          "  --dedupe-first      bersihkan duplikat file input sebelum mulai liveness check",
          "",
          "  Fitur Liveness Check:",
          "  --target            verifikasi juga akses ke situs target (misal https://tokenharbor.ai)",
          "  --append, -a        tambahkan ke proxy-live.txt yang sudah ada (tidak menimpa)",
          "  --skip-existing, -s abaikan proxy yang sudah ada di file output (jangan dicek ulang)",
          "  --timeout           detik per proxy (default 12)",
          "  -c N                berapa proxy dicek bersamaan (default 10)",
          "  --dead F            simpan juga yang mati beserta alasannya",
          "  --force             tetap tulis file walau tidak ada yang hidup",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return o;
}

/** Our own address, so a proxy that does not actually proxy can be caught. */
async function directIp(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } });
    return readExitIp(await res.text());
  } catch {
    return null;
  }
}

async function checkOne(entry: ProxyEntry, opts: CheckOptions, ourIp: string | null): Promise<CheckResult> {
  const started = Date.now();
  let baseResult: CheckResult;

  if (entry.protocol.startsWith("socks")) {
    baseResult = await checkSocks(entry, opts, ourIp);
  } else {
    try {
      const res = await fetch(opts.url, {
        proxy: entry.url,
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { "user-agent": "curl/8.5.0" },
        tls: { rejectUnauthorized: false },
      });
      const ms = Date.now() - started;
      if (!res.ok) {
        baseResult = { entry, alive: false, ms, reason: `HTTP ${res.status}` };
      } else {
        const exitIp = readExitIp(await res.text());
        const verdict = judge(exitIp, ourIp);
        baseResult = { entry, alive: verdict.alive, ms, exitIp: exitIp ?? undefined, reason: verdict.reason };
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const reason = /timeout|timed out|aborted/i.test(msg) ? "timeout" : msg.slice(0, 60);
      baseResult = { entry, alive: false, ms: Date.now() - started, reason };
    }
  }

  // If base check failed, or no secondary target requested, return immediately
  if (!baseResult.alive || !opts.target) {
    return baseResult;
  }

  // Also verify that the proxy can reach the actual target website (e.g. https://tokenharbor.ai)
  const targetStarted = Date.now();
  try {
    if (entry.protocol.startsWith("socks")) {
      const targetRes = await checkSocks(entry, { url: opts.target, timeoutMs: opts.timeoutMs }, null);
      if (!targetRes.alive) {
        return { entry, alive: false, ms: Date.now() - started, reason: `target: ${targetRes.reason || "gagal"}` };
      }
    } else {
      const res = await fetch(opts.target, {
        proxy: entry.url,
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        tls: { rejectUnauthorized: false },
      });
      if (!res.ok || res.status !== 200) {
        return { entry, alive: false, ms: Date.now() - started, reason: `target HTTP ${res.status}` };
      }
    }
    const totalMs = (Date.now() - targetStarted) + baseResult.ms;
    return { ...baseResult, ms: totalMs };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const reason = /timeout|timed out|aborted/i.test(msg) ? "target timeout" : `target: ${msg.slice(0, 40)}`;
    return { entry, alive: false, ms: Date.now() - started, reason };
  }
}

/**
 * The file the apps read. Header lines are comments (skipped by every loader),
 * then one bare proxy per line, fastest first — the queue hands them out in
 * file order, so the fastest proxies land on the first accounts.
 */
export function renderLiveFile(alive: CheckResult[], opts: CheckOptions, total: number): string {
  return [
    "# proxy hidup per " + new Date().toISOString(),
    "# sumber: " + path.basename(opts.input) + " · " + alive.length + "/" + total + " lolos · urut dari tercepat" + (opts.target ? ` · target: ${opts.target}` : ""),
    ...alive.map((r) => r.entry.raw),
    "",
  ].join(String.fromCharCode(10));
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const hasExplicitOut = argv.includes("--out");

  // ── Mode Format & Deduplikasi (Hilangkan Duplikat) ──────────────────
  if (opts.dedupe) {
    console.log(`\n${ui.bold("format & bersihkan duplikat proxy")} ${ui.dim(`mode: ${opts.mode} · style: ${opts.style}`)}\n`);
    const filesToProcess: { in: string; out: string }[] = [];

    if (opts.dedupeAll) {
      const p1 = path.resolve(process.cwd(), "proxy.txt");
      const p2 = path.resolve(process.cwd(), "proxy-live.txt");
      if (fs.existsSync(p1)) filesToProcess.push({ in: p1, out: p1 });
      if (fs.existsSync(p2)) filesToProcess.push({ in: p2, out: p2 });
      if (filesToProcess.length === 0) {
        console.error(ui.red("[proxy-check] Tidak ada file proxy.txt atau proxy-live.txt yang ditemukan."));
        return 1;
      }
    } else {
      if (!fs.existsSync(opts.input)) {
        console.error(ui.red(`[proxy-check] ${path.basename(opts.input)} tidak ditemukan.`));
        return 1;
      }
      const outTarget = hasExplicitOut ? opts.output : opts.input;
      filesToProcess.push({ in: opts.input, out: outTarget });
    }

    let totalCleanedDuplicates = 0;
    for (const f of filesToProcess) {
      if (!fs.existsSync(f.in)) {
        console.log(ui.yellow(`  file ${path.basename(f.in)} tidak ditemukan, dilewati.`));
        continue;
      }
      const rawText = fs.readFileSync(f.in, "utf8");
      const res = dedupeAndFormatProxies(rawText, {
        mode: opts.mode,
        style: opts.style,
      });
      totalCleanedDuplicates += res.duplicatesRemoved;

      if (opts.backup && path.resolve(f.in) === path.resolve(f.out)) {
        fs.writeFileSync(`${f.in}.bak`, rawText, "utf8");
      }
      fs.writeFileSync(f.out, res.output, "utf8");

      const isSameFile = path.resolve(f.in) === path.resolve(f.out);
      console.log(`  ${ui.bold(path.basename(f.in))}:`);
      console.log(`    • Total baris dibaca    : ${res.totalLines.toLocaleString()}`);
      console.log(`    • Proxy duplikat dihapus: ${ui.yellow(res.duplicatesRemoved.toLocaleString())} ${opts.mode === "exact" ? "(string persis)" : "(IP & port sama)"}`);
      if (res.invalidSkipped > 0) {
        console.log(`    • Baris rusak/dilewati  : ${ui.red(res.invalidSkipped.toLocaleString())}`);
      }
      console.log(`    • Proxy unik tersisa    : ${ui.green(res.uniqueCount.toLocaleString())}`);
      console.log(`    ${ui.green("→")} Disimpan ke: ${ui.bold(path.basename(f.out))}${isSameFile ? " (diperbarui langsung)" : ""}\n`);
    }

    console.log(ui.green(`✔ Format & pembersihan duplikat selesai! Total ${totalCleanedDuplicates.toLocaleString()} duplikat disingkirkan.\n`));
    return 0;
  }

  // Pra-cek deduplikasi pada input file jika diminta
  if (opts.dedupeFirst && fs.existsSync(opts.input)) {
    const rawText = fs.readFileSync(opts.input, "utf8");
    const res = dedupeAndFormatProxies(rawText, { mode: opts.mode, style: opts.style });
    if (res.duplicatesRemoved > 0) {
      if (opts.backup) fs.writeFileSync(`${opts.input}.bak`, rawText, "utf8");
      fs.writeFileSync(opts.input, res.output, "utf8");
      console.log(ui.dim(`  [pra-cek] ${res.duplicatesRemoved.toLocaleString()} duplikat di ${path.basename(opts.input)} telah dibersihkan terlebih dahulu.\n`));
    }
  }

  if (!fs.existsSync(opts.input)) {
    console.error(ui.red(`[proxy-check] ${path.basename(opts.input)} tidak ada — jalankan webshare dulu.`));
    return 1;
  }
  const { entries: parsedEntries, skipped, duplicates } = parseProxyFile(fs.readFileSync(opts.input, "utf8"));
  for (const bad of skipped) console.log(ui.yellow(`  lewati baris tidak valid: ${mask(bad)}`));
  if (duplicates > 0) {
    console.log(ui.yellow(`  lewati ${duplicates} proxy duplikat di ${path.basename(opts.input)} (IP & port sama, diabaikan)`));
  }

  const existingParsed = fs.existsSync(opts.output)
    ? parseProxyFile(fs.readFileSync(opts.output, "utf8"))
    : { entries: [], skipped: [], duplicates: 0 };
  const existingCount = existingParsed.entries.length;
  const seenEndpoints = new Set(existingParsed.entries.map((e) => e.hostPort));

  let entries = parsedEntries;
  if (opts.append || opts.skipExisting) {
    const beforeCount = entries.length;
    entries = entries.filter((e) => !seenEndpoints.has(e.hostPort));
    const alreadyLiveCount = beforeCount - entries.length;
    if (alreadyLiveCount > 0) {
      console.log(
        ui.dim(`  lewati ${alreadyLiveCount} proxy yang sudah ada di ${path.basename(opts.output)} (IP & port sama, tidak dicek ulang)`),
      );
    }
  }

  if (entries.length === 0) {
    if ((opts.append || opts.skipExisting) && existingCount > 0) {
      console.log(
        ui.green(`\n[proxy-check] Semua proxy unik (${parsedEntries.length}) sudah ada di ${path.basename(opts.output)}. Tidak ada proxy baru yang perlu dicek.`),
      );
      return 0;
    }
    console.error(ui.red(`[proxy-check] tidak ada proxy yang bisa dicek di ${path.basename(opts.input)}.`));
    return 1;
  }

  // Establish our own IP first. Without it we cannot tell a transparent proxy
  // from a working one — and if this fails, the internet is down here and
  // every proxy would look dead.
  const ourIp = await directIp(opts.url, opts.timeoutMs);
  if (!ourIp) {
    console.error(
      ui.red(`[proxy-check] tidak bisa menghubungi ${opts.url} tanpa proxy — cek koneksi dulu, jangan percaya hasilnya.`),
    );
    return 1;
  }

  console.log(
    `\n${ui.bold("cek proxy")} ${ui.dim(
      `${entries.length} entri${duplicates > 0 || parsedEntries.length > entries.length ? ` (dari ${parsedEntries.length + duplicates} baris)` : ""} · ${opts.concurrency} paralel · timeout ${opts.timeoutMs / 1000}s · ip kita ${ourIp}${
        opts.target ? ` · target ${opts.target}` : ""
      }${opts.append ? " · mode append" : " · stream real-time"}`,
    )}\n`,
  );

  let done = 0;
  let newLiveCount = 0;
  let liveCount = opts.append ? existingCount : 0;
  let deadCount = 0;

  const onSigint = () => {
    const totalLive = opts.append ? liveCount : newLiveCount;
    if (totalLive > 0) {
      console.log(
        `\n\n${ui.yellow("Dihentikan")} — ${ui.green(`${totalLive} proxy hidup`)} sudah langsung tersimpan di ${ui.bold(path.basename(opts.output))}.`,
      );
    } else {
      console.log(`\n\n${ui.yellow("Dihentikan")} — belum ada proxy hidup yang ditemukan.`);
    }
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const results = await pool(entries, opts.concurrency, async (entry) => {
    const r = await checkOne(entry, opts, ourIp);
    done++;

    if (r.alive) {
      if (opts.append) {
        if (!seenEndpoints.has(entry.hostPort)) {
          seenEndpoints.add(entry.hostPort);
          fs.appendFileSync(opts.output, entry.raw + "\n", "utf8");
          newLiveCount++;
          liveCount++;
        }
      } else {
        if (!seenEndpoints.has(entry.hostPort)) {
          seenEndpoints.add(entry.hostPort);
          if (newLiveCount === 0) {
            // Inisialisasi file saat proxy hidup pertama kali ditemukan
            fs.writeFileSync(
              opts.output,
              [
                "# proxy hidup per " + new Date().toISOString(),
                "# sumber: " + path.basename(opts.input) + (opts.target ? ` · target: ${opts.target}` : "") + " (streaming)",
                entry.raw,
                "",
              ].join("\n"),
              "utf8",
            );
          } else {
            // Stream/append langsung ke file
            fs.appendFileSync(opts.output, entry.raw + "\n", "utf8");
          }
          newLiveCount++;
          liveCount++;
        }
      }
    } else if (opts.deadFile) {
      if (deadCount === 0 && !fs.existsSync(opts.deadFile)) {
        fs.writeFileSync(opts.deadFile, `${entry.raw}  # ${r.reason ?? "mati"}\n`, "utf8");
      } else {
        fs.appendFileSync(opts.deadFile, `${entry.raw}  # ${r.reason ?? "mati"}\n`, "utf8");
      }
      deadCount++;
    }

    const tag = r.alive ? ui.green("hidup") : ui.red("mati ");
    const detail = r.alive ? ui.dim(r.exitIp ?? "") : ui.dim(r.reason ?? "");
    const liveIndicator = liveCount > 0 ? ui.green(` [live: ${liveCount}]`) : "";
    console.log(
      `  ${String(done).padStart(3)}/${entries.length} ${tag} ${String(r.ms).padStart(5)}ms  ${mask(entry.raw).padEnd(46)} ${detail}${liveIndicator}`,
    );
    return r;
  });

  process.off("SIGINT", onSigint);

  const alive = sortByLatency(results.filter((r) => r.alive));
  const stats = summarise(results);
  console.log(
    `\n${ui.bold("hasil")} ${ui.green(`${stats.alive} hidup`)} · ${ui.red(`${stats.dead} mati`)}` +
      (stats.alive ? ` · ${ui.dim(`median ${stats.medianMs}ms`)}` : ""),
  );

  if (opts.deadFile && deadCount > 0) {
    console.log(ui.dim(`  ${deadCount} proxy mati dicatat di ${path.basename(opts.deadFile)}`));
  }

  // Refuse to replace a usable pool with an empty one: a blip in our own
  // connection should not wipe the file the apps are about to read.
  if (alive.length === 0 && existingCount > 0 && !opts.force && !opts.append) {
    console.log(
      ui.yellow(
        `\n  tidak ada yang hidup — ${path.basename(opts.output)} lama (${existingCount} entri) dibiarkan.` +
          ` Pakai --force kalau memang mau dikosongkan.`,
      ),
    );
    return 2;
  }

  // Final rewrite: sort by latency (fastest first) and write complete header
  if (alive.length > 0 && !opts.append) {
    const seenLive = new Set<string>();
    const uniqueAlive: CheckResult[] = [];
    for (const res of alive) {
      if (!seenLive.has(res.entry.hostPort)) {
        seenLive.add(res.entry.hostPort);
        uniqueAlive.push(res);
      }
    }
    fs.writeFileSync(opts.output, renderLiveFile(uniqueAlive, opts, results.length), "utf8");
    console.log(`  ${ui.green("→")} ${uniqueAlive.length} proxy ditulis ke ${ui.bold(path.basename(opts.output))} (diurutkan dari tercepat)`);
  } else if (opts.append && newLiveCount > 0) {
    if (fs.existsSync(opts.output)) {
      const cleanLive = dedupeAndFormatProxies(fs.readFileSync(opts.output, "utf8"), { mode: "endpoint" });
      if (cleanLive.duplicatesRemoved > 0) {
        fs.writeFileSync(opts.output, cleanLive.output, "utf8");
      }
    }
    console.log(`  ${ui.green("→")} ${newLiveCount} proxy baru ditambahkan ke ${ui.bold(path.basename(opts.output))} (total ${liveCount})`);
  }
  return (opts.append ? liveCount : alive.length) > 0 ? 0 : 2;
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(ui.red(`[proxy-check] ${(e as Error).message}`));
      process.exit(1);
    });
}
