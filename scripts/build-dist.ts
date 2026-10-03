#!/usr/bin/env bun
// ── Build what gets deployed ───────────────────────────────────────
// Our code goes out as one minified bundle per app. The three puppeteer
// packages stay external and are installed on the target with `bun install`:
// they are public anyway, and the stealth plugin loads its evasions through a
// dynamic require that no bundler can follow (`bun build --compile` dies at
// runtime with "Cannot find package 'kind-of'").
//
// The result is a directory with no TypeScript, no comments and mangled names.

import fs from "node:fs";
import path from "node:path";

/** Public dependencies: resolved on the target, never bundled. */
const EXTERNAL = ["puppeteer-core", "puppeteer-extra", "puppeteer-extra-plugin-stealth"];
/**
 * Satu entry saja. Ketiga app dan library-nya masuk ke berkas yang sama,
 * dipilih lewat sub-perintah, supaya yang perlu diunggah ke VPS cuma satu file.
 */
const ENTRY = "scripts/runner-entry.ts";
const OUT_NAME = "runner.js";

const outDir = path.resolve(process.cwd(), "dist");

async function main(): Promise<number> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: outDir,
    target: "bun",
    minify: true,
    external: EXTERNAL,
    naming: OUT_NAME,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return 1;
  }
  const size = fs.statSync(path.join(outDir, OUT_NAME)).size;
  console.log(
    `  ${OUT_NAME.padEnd(12)} ${(size / 1024).toFixed(0).padStart(4)} KB  (cbdg + crusoe + fastrouter + tokenharbor + webshare + proxy-check + library)`,
  );

  // The target installs these itself; pinning the majors we tested against.
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(
      {
        name: "automation-runner",
        private: true,
        type: "module",
        dependencies: {
          "puppeteer-core": "^23.0.0",
          "puppeteer-extra": "^3.3.6",
          "puppeteer-extra-plugin-stealth": "^2.11.2",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "RUN.md"),
    [
      "# Menjalankan bundle ini",
      "",
      "```bash",
      "bun install                       # sekali saja: 3 paket puppeteer",
      "bun runner.js doctor              # cek browser, seed dan proxy",
      "bun runner.js webshare --headless --fast --delay 60",
      "bun runner.js proxy-check",
      "bun runner.js crusoe --headless --fast --delay 60",
      "bun runner.js fastrouter --headless --fast --delay 60",
      "bun runner.js tokenharbor --headless --fast --delay 60",
      "bun runner.js cbdg --headless --signup-only --with-proxy --delay 60",
      "```",
      "",
      "Butuh `gsuite.txt` di folder ini. `proxy-live.txt` dan `vcc.txt` opsional.",
      "Browser: chromium atau google-chrome harus terpasang di mesin ini.",
      "",
      "Supaya tetap jalan setelah ssh diputus, pakai `./run.sh` dari bootstrap.",
      "",
    ].join(String.fromCharCode(10)),
    "utf8",
  );

  console.log(`\n  → ${outDir}`);
  console.log("  isinya: 1 bundle + package.json + RUN.md (tanpa satupun file .ts)");
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
