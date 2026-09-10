#!/usr/bin/env bun
// ── Interactive launcher ───────────────────────────────────────────
// One entry point for every app in the repo: pick what to run, how far to take
// it, how fast, and whether to spread accounts over the harvested proxies.
// Everything it can do is also reachable by typing the flags directly; the
// command it is about to run is printed so you can copy it next time.

import { select, confirm, askNumber, releaseStdin, ui, Cancelled } from "./prompt.js";
import {
  APP_ENTRY,
  IS_TOOL,
  PROXY_CAPABLE,
  googleDirectEnabled,
  buildArgs,
  commandLine,
  readSeeds,
  warningsFor,
  type AppName,
  type CbdgMode,
  type Pace,
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
    { value: "proxy-check", label: "cek proxy", hint: "proxy.txt → uji hidup/mati → proxy-live.txt" },
    { value: "crusoe", label: "crusoe", hint: "daftar Crusoe → bonus $5 + API key ke apikey.txt" },
    { value: "cbdg", label: "cbdg", hint: "daftar CodeBuddy → kredit new-user (+ VCC opsional)" },
  ]);

  // The checker has nothing to configure: it reads one file and writes another.
  if (IS_TOOL[app]) {
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

  let mode: CbdgMode | undefined;
  if (app === "cbdg") {
    mode = await select<CbdgMode>("Sampai mana?", [
      { value: "signup", label: "Signup saja", hint: "berhenti setelah daftar, tanpa VCC" },
      { value: "full", label: "Full", hint: `lanjut isi kartu + 3DS + trial (butuh vcc.txt: ${seeds.cards})` },
    ]);
  }

  let useProxy: boolean | undefined;
  let googleDirect: boolean | undefined;
  if (PROXY_CAPABLE.includes(app)) {
    const pool =
      seeds.live > 0
        ? `proxy-live.txt (${seeds.liveAddresses} alamat unik)`
        : `proxy.txt (${seeds.proxies} baris, belum dicek)`;
    useProxy = await select<boolean>("Pakai proxy?", [
      { value: true, label: "Dengan proxy", hint: `${pool}, 1 akun 1 alamat` },
      { value: false, label: "Tanpa proxy", hint: "semua akun dari IP mesin ini" },
    ], seeds.live > 0 || seeds.proxies > 0 ? 0 : 1);
    // Reads the same knob the apps read, so the review and the printed command
    // tell the truth even when .env overrides the default.
    googleDirect = useProxy ? googleDirectEnabled() : undefined;
  }

  const pace = await select<Pace>("Kecepatan?", [
    { value: "human", label: "human", hint: "default, cadence asli" },
    { value: "fast", label: "fast", hint: "tanpa menunggu yang percuma, ketikan tetap manusiawi" },
    { value: "careful", label: "careful", hint: "lebih pelan dari manusia, buat risk engine galak" },
  ]);

  const delaySec = await askNumber("Jeda antar akun", 60, " detik");
  const workers = await askNumber("Jumlah worker paralel", 1);
  const retryFailed = await confirm("Ulangi akun yang tercatat gagal?", false);
  const headless = await confirm("Headless? (captcha/3DS tidak bisa manual)", false);
  const dryRun = await confirm("Dry-run dulu? (validasi saja, tanpa browser)", false);

  return { app, mode, useProxy, googleDirect, pace, delaySec, workers, retryFailed, headless, dryRun };
}

function review(plan: RunPlan): void {
  const seeds = readSeeds();
  if (IS_TOOL[plan.app]) {
    console.log(`
${ui.bold("Rencana")}
  ${ui.dim("app".padEnd(8))} ${plan.app}`);
    const toolWarnings = warningsFor(plan, seeds);
    for (const w of toolWarnings) console.log(`  ${ui.yellow("!")} ${w}`);
    console.log(`
${ui.dim("perintah:")} ${ui.cyan(commandLine(plan))}`);
    return;
  }
  const rows: Array<[string, string]> = [
    ["app", plan.app],
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
      ? ([["google", plan.googleDirect === false ? "lewat proxy" : "langsung (hindari captcha)"]] as Array<[string, string]>)
      : []),
    ["pace", plan.pace],
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
