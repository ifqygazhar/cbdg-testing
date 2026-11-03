#!/usr/bin/env bun
// ── Cloudflare WARP Management & IP Switcher TUI ────────────────────────────
// Menangani status, toggle ON/OFF, cek IP publik, dan rotasi/switch IP WARP.

import { select, confirm, releaseStdin, ui, Cancelled } from "./prompt.js";

export interface WarpInfo {
  status: string;
  isWarp: boolean;
  ipv4?: string;
  ipv6?: string;
  activeIp: string;
  colo?: string;
  loc?: string;
}

export async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (err: any) {
    return { stdout: "", stderr: String(err?.message || err), exitCode: 1 };
  }
}

export async function isWarpInstalled(): Promise<boolean> {
  const { exitCode } = await runCommand(["which", "warp-cli"]);
  return exitCode === 0;
}

export async function getWarpDaemonStatus(): Promise<string> {
  const { stdout, exitCode } = await runCommand(["warp-cli", "status"]);
  if (exitCode !== 0) return "Not Running / Error";
  const match = stdout.match(/Status update:\s*([^\n\r]+)/i);
  return match ? match[1].trim() : stdout.split("\n")[0] || "Unknown";
}

export async function fetchTrace(url = "https://1.1.1.1/cdn-cgi/trace"): Promise<Record<string, string>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return {};
    const text = await res.text();
    const map: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const idx = line.indexOf("=");
      if (idx !== -1) {
        map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return map;
  } catch {
    return {};
  }
}

export async function getWarpInfo(): Promise<WarpInfo> {
  const daemonStatus = await getWarpDaemonStatus();

  // Ambil trace utama
  const trace1 = await fetchTrace("https://1.1.1.1/cdn-cgi/trace");
  const traceGlobal = await fetchTrace("https://www.cloudflare.com/cdn-cgi/trace");

  const isWarp = trace1.warp === "on" || traceGlobal.warp === "on";
  const colo = trace1.colo || traceGlobal.colo || "Unknown";
  const loc = trace1.loc || traceGlobal.loc || "Unknown";

  let ipv4: string | undefined;
  let ipv6: string | undefined;

  // Analisis IP
  for (const t of [trace1, traceGlobal]) {
    if (t.ip) {
      if (t.ip.includes(":")) ipv6 = t.ip;
      else ipv4 = t.ip;
    }
  }

  // Jika IPv4 belum ditemukan, coba via ipify
  if (!ipv4) {
    try {
      const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
      if (r.ok) ipv4 = (await r.text()).trim();
    } catch {}
  }

  const activeIp = ipv6 || ipv4 || "Unknown";

  return {
    status: daemonStatus,
    isWarp,
    ipv4,
    ipv6,
    activeIp,
    colo,
    loc,
  };
}

export function printBanner(info: WarpInfo): void {
  const statusStr = info.status.toLowerCase().includes("connect")
    ? ui.green(info.status)
    : ui.yellow(info.status);

  const warpStr = info.isWarp ? ui.green("ON (Cloudflare Protected)") : ui.yellow("OFF (Direct ISP/VPS IP)");

  console.log(`
${ui.bold("============================================================")}
  ${ui.cyan(ui.bold("🌐 CLOUDFLARE WARP MANAGER & IP SWITCHER"))}
${ui.bold("============================================================")}
  Status Daemon : ${statusStr}
  Mode WARP     : ${warpStr}
  Outbound IPv4 : ${info.ipv4 ? ui.cyan(info.ipv4) : ui.dim("(tidak terdeteksi)")}
  Outbound IPv6 : ${info.ipv6 ? ui.cyan(info.ipv6) : ui.dim("(tidak terdeteksi)")}
  Datacenter    : ${ui.bold(info.colo || "Unknown")} (Negara: ${info.loc || "Unknown"})
${ui.bold("============================================================")}`);
}

/** Nyalakan koneksi WARP */
export async function enableWarp(): Promise<void> {
  console.log(ui.cyan("Mengaktifkan Cloudflare WARP..."));
  await runCommand(["warp-cli", "mode", "warp"]);
  const res = await runCommand(["warp-cli", "connect"]);
  if (res.exitCode !== 0) {
    console.error(ui.red(`Gagal menyambungkan: ${res.stderr || res.stdout}`));
    return;
  }
  // Tunggu koneksi stabil
  await new Promise((r) => setTimeout(r, 2000));
  const info = await getWarpInfo();
  if (info.isWarp) {
    console.log(ui.green(`✓ Cloudflare WARP Aktif! Outbound IP: ${info.activeIp} (${info.colo})`));
  } else {
    console.log(ui.yellow(`WARP connect dikirim (Status: ${info.status}), Outbound IP: ${info.activeIp}`));
  }
}

/** Matikan koneksi WARP */
export async function disableWarp(): Promise<void> {
  console.log(ui.yellow("Memutuskan koneksi Cloudflare WARP..."));
  const res = await runCommand(["warp-cli", "disconnect"]);
  if (res.exitCode !== 0) {
    console.error(ui.red(`Gagal memutuskan: ${res.stderr || res.stdout}`));
    return;
  }
  await new Promise((r) => setTimeout(r, 2000));
  const info = await getWarpInfo();
  console.log(ui.green(`✓ Cloudflare WARP Dimatikan! Kembali ke IP asli: ${info.activeIp}`));
}

/** Switch IP Cepat via Rotate Keys & Reconnect */
export async function switchIpQuick(): Promise<boolean> {
  console.log(ui.cyan("Memutar kunci tunnel (rotate-keys) & menyambung ulang..."));
  await runCommand(["warp-cli", "tunnel", "rotate-keys"]);
  await runCommand(["warp-cli", "disconnect"]);
  await new Promise((r) => setTimeout(r, 1000));
  await runCommand(["warp-cli", "connect"]);
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

/** Switch IP Fresh via New Registration (Paling Efektif Mendapatkan Pool Baru) */
export async function switchIpFresh(): Promise<{ oldIp: string; newIp: string; success: boolean }> {
  const before = await getWarpInfo();
  console.log(ui.cyan(`Mendaftarkan ulang identitas client WARP baru (IP saat ini: ${before.activeIp})...`));

  await runCommand(["warp-cli", "disconnect"]);
  await runCommand(["warp-cli", "registration", "delete"]);

  const reg = await runCommand(["warp-cli", "--accept-tos", "registration", "new"]);
  if (reg.exitCode !== 0) {
    await runCommand(["warp-cli", "registration", "new"]);
  }

  await runCommand(["warp-cli", "mode", "warp"]);
  await runCommand(["warp-cli", "connect"]);

  // Tunggu stabil
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const current = await getWarpDaemonStatus();
    if (current.toLowerCase().includes("connect")) break;
  }

  const after = await getWarpInfo();
  const changed = before.activeIp !== after.activeIp || before.ipv6 !== after.ipv6;

  return {
    oldIp: before.activeIp,
    newIp: after.activeIp,
    success: changed || after.isWarp,
  };
}

/** Auto Switch Loop: Tekan Enter untuk switch atau jeda otomatis */
export async function runAutoSwitchLoop(): Promise<void> {
  console.log(`
${ui.bold("============================================================")}
  ${ui.cyan(ui.bold("🔁 AUTO SWITCH IP LOOP"))}
${ui.bold("============================================================")}
  • Tekan ${ui.bold("Enter")} untuk segera ganti IP baru.
  • Tekan ${ui.bold("Ctrl+C")} untuk keluar kembali ke menu.
`);

  while (true) {
    try {
      const infoBefore = await getWarpInfo();
      console.log(`\nIP Saat Ini : ${ui.cyan(infoBefore.activeIp)} | Datacenter: ${ui.bold(infoBefore.colo || "Unknown")}`);
      console.log(ui.dim("Tekan Enter untuk Switch IP baru..."));

      await new Promise<void>((resolve) => {
        const onData = (data: Buffer) => {
          process.stdin.off("data", onData);
          resolve();
        };
        process.stdin.resume();
        process.stdin.on("data", onData);
      });

      process.stdout.write(ui.cyan("Sedang berganti IP... "));
      const res = await switchIpFresh();
      if (res.oldIp !== res.newIp) {
        console.log(ui.green(`SUKSES! IP berubah: ${ui.yellow(res.oldIp)} ➔ ${ui.green(res.newIp)}`));
      } else {
        console.log(ui.green(`Koneksi disegarkan! Egress IP: ${ui.green(res.newIp)}`));
      }
    } catch {
      break;
    }
  }
}

/** Menu TUI Interaktif */
export async function runTui(): Promise<void> {
  const installed = await isWarpInstalled();
  if (!installed) {
    console.error(ui.red("❌ Error: warp-cli tidak ditemukan di sistem ini."));
    console.log(ui.yellow("Jalankan 'sudo bash scripts/setup-vps.sh' terlebih dahulu untuk menginstal Cloudflare WARP."));
    return;
  }

  while (true) {
    const info = await getWarpInfo();
    printBanner(info);

    type MenuChoice = "switch-fresh" | "switch-quick" | "auto-loop" | "status" | "toggle-on" | "toggle-off" | "exit";

    try {
      const choice = await select<MenuChoice>("Pilih Aksi WARP:", [
        {
          value: "switch-fresh",
          label: "⚡ Switch IP Baru (Fresh Client Registration)",
          hint: "dapatkan alokasi IP Cloudflare baru dari pool (sangat direkomendasikan)",
        },
        {
          value: "switch-quick",
          label: "🔄 Switch IP Cepat (Rotate Keys & Reconnect)",
          hint: "putar cryptographic keys tunnel lalu sambung ulang secara instan",
        },
        {
          value: "auto-loop",
          label: "🔁 Auto-Switch Loop",
          hint: "rotasi IP terus-menerus setiap menekan Enter (cocok untuk farming/testing)",
        },
        {
          value: "status",
          label: "📊 Tampilkan Status Lengkap & Trace Info",
          hint: "cek detail rute, gateway, DNS, dan datacenter Cloudflare",
        },
        {
          value: "toggle-on",
          label: "🟢 Nyalakan WARP (warp-on)",
          hint: "aktifkan mode tunnel outbound WARP",
        },
        {
          value: "toggle-off",
          label: "🔴 Matikan WARP (warp-off)",
          hint: "putuskan tunnel dan kembali memakai IP publik bawaan VPS",
        },
        {
          value: "exit",
          label: "🚪 Keluar",
          hint: "tutup menu WARP Manager",
        },
      ]);

      if (choice === "exit") {
        console.log(ui.dim("Sampai jumpa!"));
        break;
      }

      if (choice === "switch-fresh") {
        const res = await switchIpFresh();
        if (res.oldIp !== res.newIp) {
          console.log(ui.green(`\n✓ Sukses berganti IP: ${ui.yellow(res.oldIp)} ➔ ${ui.green(res.newIp)}\n`));
        } else {
          console.log(ui.green(`\n✓ Registrasi ulang berhasil. Egress IP aktif: ${ui.green(res.newIp)}\n`));
        }
        await new Promise((r) => setTimeout(r, 1500));
      } else if (choice === "switch-quick") {
        const before = await getWarpInfo();
        await switchIpQuick();
        const after = await getWarpInfo();
        console.log(ui.green(`\n✓ Selesai! IP: ${ui.cyan(after.activeIp)} (Sebelumnya: ${before.activeIp})\n`));
        await new Promise((r) => setTimeout(r, 1500));
      } else if (choice === "auto-loop") {
        await runAutoSwitchLoop();
      } else if (choice === "status") {
        await printDetailedStatus();
        await confirm("\nTekan Enter untuk kembali ke menu...", true);
      } else if (choice === "toggle-on") {
        await enableWarp();
        await new Promise((r) => setTimeout(r, 1500));
      } else if (choice === "toggle-off") {
        await disableWarp();
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      if (err instanceof Cancelled) {
        console.log(ui.dim("\nKeluar dari menu."));
        break;
      }
      throw err;
    }
  }

  releaseStdin();
}

/** Tampilkan detail status diagnostik */
export async function printDetailedStatus(): Promise<void> {
  console.log(`\n${ui.bold("=== WARP Daemon Status ===")}`);
  const statusRes = await runCommand(["warp-cli", "status"]);
  console.log(statusRes.stdout || statusRes.stderr);

  console.log(`\n${ui.bold("=== Cloudflare CDN Trace ===")}`);
  const trace1 = await fetchTrace("https://1.1.1.1/cdn-cgi/trace");
  for (const [k, v] of Object.entries(trace1)) {
    console.log(`  ${k.padEnd(14)}: ${v}`);
  }

  console.log(`\n${ui.bold("=== IP Verification Summary ===")}`);
  const info = await getWarpInfo();
  console.log(`  WARP Active   : ${info.isWarp ? ui.green("YES (warp=on)") : ui.red("NO (warp=off)")}`);
  console.log(`  IPv4 Address  : ${info.ipv4 || "None"}`);
  console.log(`  IPv6 Address  : ${info.ipv6 || "None"}`);
  console.log(`  Datacenter    : ${info.colo || "Unknown"} (Region: ${info.loc || "Unknown"})`);
}

/** CLI Entrypoint */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const sub = argv[0]?.toLowerCase();

  if (sub === "status") {
    await printDetailedStatus();
    return 0;
  }

  if (sub === "ip") {
    const info = await getWarpInfo();
    const warpBadge = info.isWarp ? ui.green("[WARP ON]") : ui.yellow("[WARP OFF]");
    console.log(`${warpBadge} IP: ${ui.bold(info.activeIp)} | Datacenter: ${info.colo || "Unknown"} (${info.loc || "Unknown"})`);
    return 0;
  }

  if (sub === "on") {
    await enableWarp();
    return 0;
  }

  if (sub === "off") {
    await disableWarp();
    return 0;
  }

  if (sub === "switch" || sub === "rotate") {
    const isDeep = argv.includes("--deep") || argv.includes("--fresh") || argv.includes("-f") || !argv.includes("--quick");
    if (isDeep) {
      const res = await switchIpFresh();
      if (res.oldIp !== res.newIp) {
        console.log(ui.green(`✓ Sukses berganti IP: ${ui.yellow(res.oldIp)} ➔ ${ui.green(res.newIp)}`));
      } else {
        console.log(ui.green(`✓ Identitas WARP baru aktif! IP: ${ui.green(res.newIp)}`));
      }
    } else {
      await switchIpQuick();
      const info = await getWarpInfo();
      console.log(ui.green(`✓ Reconnect sukses! IP: ${ui.green(info.activeIp)}`));
    }
    return 0;
  }

  if (sub === "--help" || sub === "-h") {
    console.log(`
Usage:
  bun run warp             Buka menu interaktif TUI (Switch IP, Status, Toggle)
  bun run warp-status      Tampilkan status detail koneksi & trace Cloudflare
  bun run warp-ip          Tampilkan IP publik outbound saat ini secara singkat
  bun run warp-on          Aktifkan / sambungkan Cloudflare WARP
  bun run warp-off         Matikan / putuskan Cloudflare WARP (kembali ke IP VPS)
  bun run warp-switch      Ganti ke IP Cloudflare WARP baru secara otomatis
`);
    return 0;
  }

  // Default: Jalankan TUI interaktif
  await runTui();
  return 0;
}

if (import.meta.main) {
  main().then((code) => {
    if (typeof code === "number" && code !== 0) process.exit(code);
  });
}
