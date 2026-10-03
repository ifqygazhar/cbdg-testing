#!/usr/bin/env bun
// ── Proxy liveness check ───────────────────────────────────────────
// Reads the harvested pool, asks an IP echo through each proxy, and writes the
// ones that answered with somebody else's address to proxy-live.txt. The apps
// read that file, so a dead webshare proxy never costs an account.

import fs from "node:fs";
import path from "node:path";
import {
  checkSocks,
  judge,
  mask,
  parseProxyFile,
  pool,
  readExitIp,
  sortByLatency,
  summarise,
  type CheckResult,
  type ProxyEntry,
} from "./proxy-lib.js";
import { ui } from "./prompt.js";

export interface CheckOptions {
  input: string;
  output: string;
  deadFile?: string;
  url: string;
  timeoutMs: number;
  concurrency: number;
  force: boolean;
}

export function parseArgs(argv: string[], cwd = process.cwd()): CheckOptions {
  const o: CheckOptions = {
    input: path.resolve(cwd, "proxy.txt"),
    output: path.resolve(cwd, "proxy-live.txt"),
    url: process.env.PROXY_CHECK_URL || "https://ipv4.webshare.io/",
    timeoutMs: Number(process.env.PROXY_CHECK_TIMEOUT_SEC || 12) * 1000,
    concurrency: Number(process.env.PROXY_CHECK_CONCURRENCY || 10),
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--in") o.input = path.resolve(cwd, next());
    else if (a === "--out") o.output = path.resolve(cwd, next());
    else if (a === "--dead") o.deadFile = path.resolve(cwd, next());
    else if (a === "--url") o.url = next();
    else if (a === "--timeout") o.timeoutMs = Number(next()) * 1000;
    else if (a === "--concurrency" || a === "-c") o.concurrency = Number(next());
    else if (a === "--force") o.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: bun run proxy-check [--in FILE] [--out FILE] [--dead FILE]",
          "                           [--timeout SEC] [-c N] [--url URL] [--force]",
          "",
          "  Membaca proxy.txt, mengecek satu per satu, menulis yang hidup ke",
          "  proxy-live.txt (diurutkan dari yang tercepat).",
          "",
          "  --timeout   detik per proxy (default 12)",
          "  -c N        berapa proxy dicek bersamaan (default 10)",
          "  --dead F    simpan juga yang mati beserta alasannya",
          "  --force     tetap tulis file walau tidak ada yang hidup",
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
  if (entry.protocol.startsWith("socks")) {
    return checkSocks(entry, opts, ourIp);
  }

  try {
    const res = await fetch(opts.url, {
      proxy: entry.url,
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { "user-agent": "curl/8.5.0" },
      tls: { rejectUnauthorized: false },
    });
    const ms = Date.now() - started;
    if (!res.ok) return { entry, alive: false, ms, reason: `HTTP ${res.status}` };
    const exitIp = readExitIp(await res.text());
    const verdict = judge(exitIp, ourIp);
    return { entry, alive: verdict.alive, ms, exitIp: exitIp ?? undefined, reason: verdict.reason };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const reason = /timeout|timed out|aborted/i.test(msg) ? "timeout" : msg.slice(0, 60);
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
    "# sumber: " + path.basename(opts.input) + " · " + alive.length + "/" + total + " lolos · urut dari tercepat",
    ...alive.map((r) => r.entry.raw),
    "",
  ].join(String.fromCharCode(10));
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);

  if (!fs.existsSync(opts.input)) {
    console.error(ui.red(`[proxy-check] ${path.basename(opts.input)} tidak ada — jalankan webshare dulu.`));
    return 1;
  }
  const { entries, skipped } = parseProxyFile(fs.readFileSync(opts.input, "utf8"));
  for (const bad of skipped) console.log(ui.yellow(`  lewati baris tidak valid: ${mask(bad)}`));
  if (entries.length === 0) {
    console.error(ui.red(`[proxy-check] tidak ada proxy di ${path.basename(opts.input)}.`));
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
      `${entries.length} entri · ${opts.concurrency} paralel · timeout ${opts.timeoutMs / 1000}s · ip kita ${ourIp}`,
    )}\n`,
  );

  let done = 0;
  const results = await pool(entries, opts.concurrency, async (entry) => {
    const r = await checkOne(entry, opts, ourIp);
    done++;
    const tag = r.alive ? ui.green("hidup") : ui.red("mati ");
    const detail = r.alive ? ui.dim(r.exitIp ?? "") : ui.dim(r.reason ?? "");
    console.log(
      `  ${String(done).padStart(3)}/${entries.length} ${tag} ${String(r.ms).padStart(5)}ms  ${mask(entry.raw).padEnd(46)} ${detail}`,
    );
    return r;
  });

  const alive = sortByLatency(results.filter((r) => r.alive));
  const stats = summarise(results);
  console.log(
    `\n${ui.bold("hasil")} ${ui.green(`${stats.alive} hidup`)} · ${ui.red(`${stats.dead} mati`)}` +
      (stats.alive ? ` · ${ui.dim(`median ${stats.medianMs}ms`)}` : ""),
  );

  if (opts.deadFile) {
    const dead = results.filter((r) => !r.alive);
    fs.writeFileSync(opts.deadFile, dead.map((r) => `${r.entry.raw}  # ${r.reason ?? "mati"}`).join("\n") + "\n", "utf8");
    console.log(ui.dim(`  ${dead.length} proxy mati dicatat di ${path.basename(opts.deadFile)}`));
  }

  // Refuse to replace a usable pool with an empty one: a blip in our own
  // connection should not wipe the file the apps are about to read.
  const existing = fs.existsSync(opts.output)
    ? parseProxyFile(fs.readFileSync(opts.output, "utf8")).entries.length
    : 0;
  if (alive.length === 0 && existing > 0 && !opts.force) {
    console.log(
      ui.yellow(
        `\n  tidak ada yang hidup — ${path.basename(opts.output)} lama (${existing} entri) dibiarkan.` +
          ` Pakai --force kalau memang mau dikosongkan.`,
      ),
    );
    return 2;
  }

  // Only clean proxy lines below the header: the apps parse each line with
  // `new URL(...)`, so a trailing "# 120ms" comment would make every entry
  // unparseable. Timing lives in the header and in --dead.
  fs.writeFileSync(opts.output, renderLiveFile(alive, opts, results.length), "utf8");
  console.log(`  ${ui.green("→")} ${alive.length} proxy ditulis ke ${ui.bold(path.basename(opts.output))}`);
  return alive.length > 0 ? 0 : 2;
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(ui.red(`[proxy-check] ${(e as Error).message}`));
      process.exit(1);
    });
}
