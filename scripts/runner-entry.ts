#!/usr/bin/env bun
// ── Satu bundel untuk semua app ────────────────────────────────────
// Entrypoint tunggal yang membawa cbdg, crusoe, webshare, proxy-check dan
// library @ifqy/google-oauth sekaligus. Dipakai `bun run build:dist` untuk
// menghasilkan satu berkas yang bisa dijalankan di VPS tanpa source apa pun.
//
//   bun runner.js cbdg --signup-only --delay 60
//   bun runner.js proxy-check

import { main as cbdg } from "../apps/cbdg/src/cli.js";
import { main as crusoe } from "../apps/crusoe/src/cli.js";
import { main as webshare } from "../apps/webshare/src/cli.js";
import { main as fastrouter } from "../apps/fastrouter/src/cli.js";
import { main as proxyCheck } from "./proxy-check.js";
import { main as doctor } from "./doctor.js";

type Command = (argv: string[]) => Promise<number | void>;

const COMMANDS: Record<string, Command> = {
  cbdg: (argv) => cbdg(argv),
  crusoe: (argv) => crusoe(argv),
  webshare: (argv) => webshare(argv),
  fastrouter: (argv) => fastrouter(argv),
  "proxy-check": (argv) => proxyCheck(argv),
  doctor: (argv) => doctor(argv),
};

const USAGE = [
  "Usage: bun runner.js <perintah> [flag...]",
  "",
  "  webshare      daftar via Google → panen proxy gratis ke proxy.txt",
  "  proxy-check   proxy.txt → uji hidup/mati → proxy-live.txt",
  "  crusoe        daftar Crusoe → bonus $5 + API key ke apikey.txt",
  "  fastrouter    daftar FastRouter → kredit $1 + API key ke apikey-fastrouter",
  "  cbdg          daftar CodeBuddy → kredit new-user (+ VCC opsional)",
  "  doctor        cek mesin ini siap atau belum (browser, seed, proxy)",
  "",
  "Flag tiap perintah: bun runner.js <perintah> --help",
  "",
  "Contoh di VPS (selalu headless, tidak ada layar di sana):",
  "  bun runner.js webshare --headless --fast --delay 60",
  "  bun runner.js proxy-check",
  "  bun runner.js cbdg --headless --signup-only --with-proxy --delay 60",
].join("\n");

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    console.error(`perintah tidak dikenal: ${command}\n`);
    console.error(USAGE);
    return 1;
  }
  const code = await run(rest);
  return typeof code === "number" ? code : 0;
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[runner] fatal: ${(e as Error).message}`);
      process.exit(1);
    });
}
