#!/usr/bin/env bun
/**
 * ── API Key Deduplicator & Cleaner ──────────────────────────────────
 * Interactive TUI & CLI tool to clean, deduplicate, and format API key files
 * across providers (TokenHarbor, Inferbase, GroqCloud, FastRouter, LLM7.io, Crusoe, etc.)
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { select, confirm, askText, releaseStdin, ui, Cancelled, type Choice } from "./prompt.js";

export interface KeyRecord {
  key: string;
  rawLine: string;
  email?: string;
  password?: string;
  hasCredentials: boolean;
}

export interface DedupeStats {
  filePath: string;
  totalLines: number;
  emptyOrCommentLines: number;
  uniqueCount: number;
  duplicateCount: number;
  duplicateSample: string[];
  cleanLines: string[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  hint: string;
  files: string[];
}

export const KNOWN_PROVIDERS: ProviderPreset[] = [
  {
    id: "inferbase",
    name: "Inferbase",
    hint: "apikey-inferbase.txt, vps/apikey-inferbase.txt, dataset",
    files: [
      "apikey-inferbase.txt",
      "vps/apikey-inferbase.txt",
      "inferbase-ai-dataset/apikey-inferbase.txt",
    ],
  },
  {
    id: "tokenharbor",
    name: "TokenHarbor",
    hint: "apikey-tokenharbor.txt, apikey-unli.txt, good, ratelimit, dll.",
    files: [
      "apikey-tokenharbor.txt",
      "apikey-good-tokenharbor.txt",
      "apikey-unli.txt",
      "apikey-need-verif-tokenharbor.txt",
      "apikey-ratelimit.txt",
      "apikey-tokenharbor-usage.txt",
      "vps/apikey-tokenharbor.txt",
      "vps/apikey-good-tokenharbor.txt",
      "vps/apikey-unli.txt",
      "vps/apikey-need-verif-tokenharbor.txt",
      "vps/apikey-ratelimit.txt",
      "vps/apikey-lama.txt",
      "vps/apikey-good-tokenharbor-bckp.txt",
      "tokenharbor-dataset/apikey-tokenharbor.txt",
    ],
  },
  {
    id: "groqcloud",
    name: "GroqCloud",
    hint: "apikey-groqcloud.txt, dataset",
    files: [
      "apikey-groqcloud.txt",
      "groqcloud-dataset/apikey-groqcloud.txt",
    ],
  },
  {
    id: "fastrouter",
    name: "FastRouter",
    hint: "apikey-fastrouter.txt, dataset",
    files: [
      "apikey-fastrouter.txt",
      "fastrouter_ai_dataset/apikey-fastrouter.txt",
    ],
  },
  {
    id: "llm7io",
    name: "LLM7.io",
    hint: "apikey-llm7io.txt, apikey-good-llm7io.txt, vps/apikey-llm7io.txt",
    files: [
      "apikey-llm7io.txt",
      "apikey-good-llm7io.txt",
      "akun-result-llm7io.txt",
      "vps/apikey-llm7io.txt",
    ],
  },
  {
    id: "inferencedahl",
    name: "Inference Dahl",
    hint: "apikey-inferencedahl.txt, akun-result-inferencedahl.txt, dataset",
    files: [
      "apikey-inferencedahl.txt",
      "apikey-good-inferencedahl.txt",
      "akun-result-inferencedahl.txt",
      "akun-good-inferencedahl.txt",
      "apikey-ratelimit-inferencedahl.txt",
      "vps/apikey-inferencedahl.txt",
      "inference-dahl-global-dataset/apikey-inferencedahl.txt",
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "apikey-openrouter.txt, dataset",
    files: [
      "apikey-openrouter.txt",
      "akun-result-openrouter.txt",
      "openrouter-dataset/apikey-openrouter.txt",
    ],
  },
  {
    id: "composite",
    name: "Composite Lucidity",
    hint: "apikey-composite.txt",
    files: [
      "apikey-composite.txt",
      "akun-result-composite.txt",
    ],
  },
  {
    id: "cbdg",
    name: "CodeBuddy (CBDG)",
    hint: "apikey-cbdg.txt, akun-result.txt",
    files: [
      "apikey-cbdg.txt",
      "akun-result.txt",
    ],
  },
  {
    id: "zromoonmath",
    name: "Zro MoonMath",
    hint: "apikey-zro.txt, dataset",
    files: [
      "apikey-zro.txt",
      "akun-result-zro.txt",
      "zromoonshotai-dataset/apikey-zro.txt",
    ],
  },
  {
    id: "crusoe",
    name: "Crusoe Cloud",
    hint: "apikey.txt, keys.txt",
    files: [
      "apikey.txt",
      "keys.txt",
    ],
  },
];

/**
 * Parses a single text line into a normalized KeyRecord.
 * Correctly detects plain keys, delimited formats (email:pass:key),
 * and strips trailing metadata/timestamps.
 */
export function parseLineToKeyRecord(line: string): KeyRecord | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }

  // 1. Remove trailing timestamp/metadata if present (e.g. ...|2026-10-18T...)
  let clean = trimmed;
  if (clean.includes("|")) {
    const pipeIdx = clean.lastIndexOf("|");
    const trailing = clean.slice(pipeIdx + 1).trim();
    if (trailing.includes("T") || trailing.includes("-") || trailing.length >= 10) {
      clean = clean.slice(0, pipeIdx).trim();
    }
  }

  // 2. JSON line support (e.g. {"apiKey": "...", "email": "..."})
  if (clean.startsWith("{") && clean.endsWith("}")) {
    try {
      const obj = JSON.parse(clean);
      const k = obj.apiKey || obj.key || obj.api_key;
      if (k && typeof k === "string") {
        return {
          key: k.trim(),
          rawLine: trimmed,
          email: obj.email,
          password: obj.password,
          hasCredentials: Boolean(obj.email),
        };
      }
    } catch {
      // not json, continue
    }
  }

  // 3. Colon-delimited formats (e.g. email:password:apikey, email:apikey, or username:apikey)
  if (clean.includes(":")) {
    const parts = clean.split(":");
    if (parts.length >= 3) {
      const first = parts[0].trim();
      const last = parts[parts.length - 1].trim();
      if (
        first.includes("@") ||
        last.startsWith("dahl_") ||
        last.startsWith("thk_") ||
        last.startsWith("inf_") ||
        last.startsWith("gsk_") ||
        last.startsWith("sk-") ||
        last.length >= 20
      ) {
        return {
          key: last,
          rawLine: clean,
          email: first,
          password: parts.slice(1, -1).join(":"),
          hasCredentials: true,
        };
      }
    } else if (parts.length === 2) {
      const first = parts[0].trim();
      const second = parts[1].trim();
      if (
        first.includes("@") ||
        second.startsWith("dahl_") ||
        second.startsWith("thk_") ||
        second.startsWith("inf_") ||
        second.startsWith("gsk_") ||
        second.startsWith("sk-") ||
        second.length >= 20
      ) {
        return {
          key: second,
          rawLine: clean,
          email: first,
          hasCredentials: true,
        };
      }
    }
  }

  // 4. Default: Plain API key string
  return {
    key: clean,
    rawLine: clean,
    hasCredentials: false,
  };
}

/**
 * Supported output formatting styles.
 */
export type FormatStyle = "smart" | "plain" | "account";

/**
 * Formats a KeyRecord into the target format string.
 */
export function formatKeyRecord(record: KeyRecord, formatStyle: FormatStyle = "smart"): string {
  if (formatStyle === "plain") {
    return record.key;
  }
  if (formatStyle === "account") {
    if (record.email && record.password) {
      return `${record.email}:${record.password}:${record.key}`;
    }
    if (record.email) {
      return `${record.email}:${record.key}`;
    }
    return record.key;
  }
  // "smart" / default: preserve clean rawLine
  return record.rawLine;
}

/**
 * Masks an API key for safe terminal display.
 */
export function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 9)}••••••••${key.slice(-6)}`;
}

/**
 * Deduplicates an array of lines according to specified strategy and format style.
 */
export function dedupeLines(
  rawLines: string[],
  strategy: "smart" | "exact" | "first" = "smart",
  formatStyle: FormatStyle = "smart",
): DedupeStats {
  const cleanLines: string[] = [];
  const duplicateSample: string[] = [];
  let emptyOrCommentLines = 0;

  if (strategy === "exact") {
    const seen = new Set<string>();
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        emptyOrCommentLines++;
        continue;
      }
      const record = parseLineToKeyRecord(trimmed);
      const outLine = record ? formatKeyRecord(record, formatStyle) : trimmed;
      if (seen.has(outLine)) {
        if (duplicateSample.length < 5) {
          duplicateSample.push(outLine);
        }
      } else {
        seen.add(outLine);
        cleanLines.push(outLine);
      }
    }
    return {
      filePath: "",
      totalLines: rawLines.length,
      emptyOrCommentLines,
      uniqueCount: cleanLines.length,
      duplicateCount: seen.size > 0 ? rawLines.length - emptyOrCommentLines - seen.size : 0,
      duplicateSample,
      cleanLines,
    };
  }

  // Key-based deduplication (smart or first)
  // Map key -> { record, indexInCleanLines }
  const keyMap = new Map<string, { record: KeyRecord; index: number }>();

  for (const line of rawLines) {
    const record = parseLineToKeyRecord(line);
    if (!record) {
      emptyOrCommentLines++;
      continue;
    }

    const existing = keyMap.get(record.key);
    if (existing) {
      if (duplicateSample.length < 5) {
        duplicateSample.push(maskKey(record.key));
      }

      // In "smart" mode: if the new record has email/password credentials and the existing one does not,
      // replace the plain key with the richer credentials line!
      if (strategy === "smart" && record.hasCredentials && !existing.record.hasCredentials) {
        existing.record = record;
        cleanLines[existing.index] = formatKeyRecord(record, formatStyle);
      }
    } else {
      const index = cleanLines.length;
      cleanLines.push(formatKeyRecord(record, formatStyle));
      keyMap.set(record.key, { record, index });
    }
  }

  const validLinesCount = rawLines.length - emptyOrCommentLines;
  const duplicateCount = validLinesCount - cleanLines.length;

  return {
    filePath: "",
    totalLines: rawLines.length,
    emptyOrCommentLines,
    uniqueCount: cleanLines.length,
    duplicateCount,
    duplicateSample,
    cleanLines,
  };
}

/**
 * Finds all existing files in project matching apikey patterns.
 */
export function discoverAllApiKeyFiles(root = process.cwd()): string[] {
  const results: string[] = [];

  function scanDir(dir: string, depth = 0) {
    if (depth > 2) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const full = resolve(dir, entry);
        const rel = relative(root, full);
        const st = statSync(full);
        if (st.isDirectory()) {
          scanDir(full, depth + 1);
        } else if (st.isFile()) {
          const lower = entry.toLowerCase();
          if (
            (lower.includes("apikey") || lower.includes("api-key") || lower.startsWith("akun-result")) &&
            lower.endsWith(".txt")
          ) {
            results.push(rel);
          }
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  scanDir(root);

  // Add any known files that exist but might not have been matched
  for (const p of KNOWN_PROVIDERS) {
    for (const f of p.files) {
      if (existsSync(resolve(root, f)) && !results.includes(f)) {
        results.push(f);
      }
    }
  }

  return Array.from(new Set(results)).sort();
}

/**
 * Inspects a file and returns its deduplication statistics.
 */
export function inspectFileDedupe(
  relPath: string,
  strategy: "smart" | "exact" | "first" = "smart",
  formatStyle: FormatStyle = "smart",
  root = process.cwd(),
): DedupeStats | null {
  const fullPath = resolve(root, relPath);
  if (!existsSync(fullPath)) return null;

  try {
    const content = readFileSync(fullPath, "utf-8");
    const rawLines = content.split(/\r?\n/);
    const stats = dedupeLines(rawLines, strategy, formatStyle);
    stats.filePath = relPath;
    return stats;
  } catch {
    return null;
  }
}

/**
 * Creates a backup of a file.
 */
export function createBackup(fullPath: string): string {
  const bakPath = `${fullPath}.bak`;
  copyFileSync(fullPath, bakPath);
  return bakPath;
}

/**
 * Writes deduplicated lines back to file.
 */
export function applyDedupeToFile(
  relPath: string,
  cleanLines: string[],
  backup = true,
  root = process.cwd(),
): { success: boolean; backupPath?: string; error?: string } {
  const fullPath = resolve(root, relPath);
  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${relPath}` };
  }

  try {
    let backupPath: string | undefined;
    if (backup) {
      backupPath = createBackup(fullPath);
    }

    const output = cleanLines.length > 0 ? cleanLines.join("\n") + "\n" : "";
    writeFileSync(fullPath, output, "utf-8");
    return { success: true, backupPath };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// ── Interactive TUI Mode ─────────────────────────────────────────────

async function runInteractiveTui() {
  console.log(`
${ui.bold("── API Key Deduplicator & Cleaner ──")}
${ui.dim("Pembersih dan penghapus duplikat API Key (TokenHarbor, Inferbase, GroqCloud, dll.)")}
`);

  const allFiles = discoverAllApiKeyFiles();
  let totalProjectDupes = 0;
  const fileStatsMap = new Map<string, DedupeStats>();

  for (const f of allFiles) {
    const stats = inspectFileDedupe(f, "smart");
    if (stats) {
      fileStatsMap.set(f, stats);
      totalProjectDupes += stats.duplicateCount;
    }
  }

  console.log(
    `Ditemukan ${ui.bold(String(allFiles.length))} file API key di proyek. ` +
    (totalProjectDupes > 0
      ? ui.yellow(`${totalProjectDupes} duplikat terdeteksi siap dibersihkan!`)
      : ui.green("Semua file sudah bersih dari duplikat."))
  );

  // 1. Select provider / target
  const choices: Choice<string>[] = [
    {
      value: "all",
      label: "🌟 Semua File Sekaligus (Dedupe All)",
      hint: `bersihkan seluruh ${allFiles.length} file API key di workspace (${totalProjectDupes} duplikat)`,
    },
    ...KNOWN_PROVIDERS.map((p) => {
      const existing = p.files.filter((f) => existsSync(resolve(process.cwd(), f)));
      const dupes = existing.reduce((acc, f) => acc + (fileStatsMap.get(f)?.duplicateCount || 0), 0);
      const totalKeys = existing.reduce((acc, f) => acc + (fileStatsMap.get(f)?.cleanLines.length || 0), 0);
      const statusHint = existing.length > 0
        ? `${existing.length} file (${totalKeys} keys, ${dupes > 0 ? ui.yellow(`${dupes} dupes`) : ui.green("0 dupes")})`
        : "file belum ada";
      return {
        value: p.id,
        label: `${p.name}`,
        hint: `${statusHint} · ${p.hint}`,
      };
    }),
    {
      value: "pick-file",
      label: "📁 Pilih Dari Daftar File Spesifik",
      hint: "pilih satu file tertentu dari seluruh daftar file yang ditemukan",
    },
    {
      value: "custom",
      label: "✏️ Ketik Path File Custom",
      hint: "masukkan path file teks bebas secara manual",
    },
  ];

  let targetChoice: string;
  try {
    targetChoice = await select("Mau bersihkan duplikat API key yang mana?", choices);
  } catch (e) {
    if (e instanceof Cancelled) {
      console.log(ui.dim("\nDibatalkan oleh user."));
      return;
    }
    throw e;
  }

  let selectedFiles: string[] = [];

  if (targetChoice === "all") {
    selectedFiles = allFiles;
  } else if (targetChoice === "custom") {
    const customInput = await askText("Masukkan path file yang ingin dibersihkan:", "apikey-inferbase.txt");
    const resolved = customInput.trim();
    if (!existsSync(resolve(process.cwd(), resolved))) {
      console.log(ui.red(`\nError: File "${resolved}" tidak ditemukan di direktori!`));
      return;
    }
    selectedFiles = [resolved];
  } else if (targetChoice === "pick-file") {
    const fileChoices: Choice<string>[] = allFiles.map((f) => {
      const st = fileStatsMap.get(f);
      const dupeTag = st && st.duplicateCount > 0 ? ui.yellow(`(${st.duplicateCount} duplikat)`) : ui.dim("(bersih)");
      return {
        value: f,
        label: f,
        hint: `${st ? st.totalLines : 0} baris ${dupeTag}`,
      };
    });
    try {
      const chosen = await select("Pilih file API key:", fileChoices);
      selectedFiles = [chosen];
    } catch (e) {
      if (e instanceof Cancelled) return;
      throw e;
    }
  } else {
    // Preset provider
    const preset = KNOWN_PROVIDERS.find((p) => p.id === targetChoice);
    if (!preset) return;
    const existing = preset.files.filter((f) => existsSync(resolve(process.cwd(), f)));
    if (existing.length === 0) {
      console.log(ui.yellow(`\nTidak ada file untuk ${preset.name} yang ditemukan di workspace.`));
      return;
    }
    selectedFiles = existing;
  }

  // 2. Select strategy
  const strategy = await select<"smart" | "exact" | "first">("Pilih strategi deduplikasi:", [
    {
      value: "smart",
      label: "Smart (Disarankan)",
      hint: "prioritaskan format lengkap (email:pass:key) jika ada, agar kredensial tidak hilang",
    },
    {
      value: "first",
      label: "First Seen",
      hint: "pertahankan baris pertama yang ditemukan, buang duplikat setelahnya",
    },
    {
      value: "exact",
      label: "Exact Line",
      hint: "hanya buang baris yang 100% sama persis kata demi kata",
    },
  ]);

  // 3. Select format style
  const formatStyle = await select<FormatStyle>("Pilih format output penulisan API key:", [
    {
      value: "smart",
      label: "Format Asli Bersih (Smart / Raw - Default)",
      hint: "pertahankan kredensial email:pass:key jika ada, hapus whitespace & duplikat",
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

  // 4. Backup confirmation
  const createBak = await confirm("Buat file cadangan backup (.bak) sebelum overwrite?", true);

  // 5. Calculate inspection
  console.log(`\n${ui.bold("Ringkasan Analisis Duplikasi:")}`);
  let totalOriginal = 0;
  let totalClean = 0;
  let totalDupesRemoved = 0;

  const targetStats: DedupeStats[] = [];
  for (const f of selectedFiles) {
    const st = inspectFileDedupe(f, strategy, formatStyle);
    if (st) {
      targetStats.push(st);
      totalOriginal += st.totalLines;
      totalClean += st.uniqueCount;
      totalDupesRemoved += st.duplicateCount;

      const dupeNotice = st.duplicateCount > 0
        ? ui.yellow(`-${st.duplicateCount} duplikat`)
        : ui.green("sudah unik");
      console.log(
        `  • ${ui.bold(f)}: ${st.totalLines} baris → ${ui.cyan(String(st.uniqueCount))} unik (${dupeNotice})`
      );
      if (st.duplicateSample.length > 0) {
        console.log(ui.dim(`    Sampel duplikat dibuang: ${st.duplicateSample.slice(0, 3).join(", ")}`));
      }
    }
  }

  console.log(`
${ui.bold("Total:")} ${totalOriginal} baris awal → ${ui.green(String(totalClean))} baris unik (${ui.yellow(`-${totalDupesRemoved} duplikat dibuang`)})`);

  if (totalDupesRemoved === 0) {
    console.log(ui.green("\n✨ Semua file sudah bersih! Tidak ada duplikat yang perlu dihapus."));
    return;
  }

  // 5. Confirmation to apply
  const proceed = await confirm(`Terapkan perubahan dan overwrite ${targetStats.filter(s => s.duplicateCount > 0).length} file sekarang?`, true);
  if (!proceed) {
    console.log(ui.dim("\nOperasi dibatalkan. Tidak ada file yang diubah."));
    return;
  }

  // 6. Apply
  console.log(`\n${ui.bold("Menerapkan perubahan...")}`);
  let modifiedCount = 0;
  for (const st of targetStats) {
    if (st.duplicateCount > 0) {
      const res = applyDedupeToFile(st.filePath, st.cleanLines, createBak);
      if (res.success) {
        modifiedCount++;
        const bakInfo = res.backupPath ? ui.dim(` (backup: ${basename(res.backupPath)})`) : "";
        console.log(`  ${ui.green("✔")} ${st.filePath}: ${st.totalLines} → ${st.uniqueCount} unik${bakInfo}`);
      } else {
        console.log(`  ${ui.red("✖")} ${st.filePath}: Gagal (${res.error})`);
      }
    }
  }

  console.log(`\n${ui.green(ui.bold("Selesai!"))} Berhasil membersihkan duplikat pada ${modifiedCount} file.`);
}

// ── Non-Interactive CLI Mode ─────────────────────────────────────────

function printHelp() {
  console.log(`
${ui.bold("API Key Deduplicator & Cleaner (Bun TypeScript)")}

PENGGUNAAN:
  bun run scripts/apikey-dedupe.ts              ${ui.dim("(Mode Interaktif TUI)")}
  bun run scripts/apikey-dedupe.ts [OPSI...]    ${ui.dim("(Mode CLI Langsung)")}

OPSI:
  --all                     Bersihkan semua file API key di project sekaligus
  -f, --file <path>         Target file tertentu (misal: apikey-inferbase.txt)
  --inferencedahl, --dahl   Target seluruh file Inference Dahl
  --tokenharbor             Target seluruh file TokenHarbor
  --llm7io                  Target seluruh file LLM7.io
  --inferbase               Target seluruh file Inferbase
  --groqcloud               Target seluruh file GroqCloud
  --fastrouter              Target seluruh file FastRouter
  --crusoe                  Target seluruh file Crusoe
  --openrouter              Target seluruh file OpenRouter
  --composite               Target seluruh file Composite
  --cbdg                    Target seluruh file CodeBuddy (CBDG)
  --zromoonmath, --zro      Target seluruh file Zro MoonMath
  --format <smart|plain|account>  Format penulisan output (Default: smart)
  --plain                   Hanya ekstrak string plain API key saja (shorthand --format plain)
  --account                 Format ke format akun (email:pass:key atau user:key)
  --strategy <smart|first|exact>  Strategi deduplikasi (Default: smart)
  --backup                  Buat file cadangan .bak sebelum menimpa (Default)
  --no-backup               Jangan buat file backup
  --dry-run                 Simulasi saja, jangan ubah file apa pun
  -h, --help                Tampilkan bantuan ini

CONTOH:
  ${ui.cyan("bun run key-dedupe")}
  ${ui.cyan("bun run scripts/apikey-dedupe.ts --all")}
  ${ui.cyan("bun run scripts/apikey-dedupe.ts --inferencedahl")}
  ${ui.cyan("bun run scripts/apikey-dedupe.ts --tokenharbor --plain")}
  ${ui.cyan("bun run scripts/apikey-dedupe.ts -f apikey-inferbase.txt --strategy smart")}
  ${ui.cyan("bun run scripts/apikey-dedupe.ts --all --dry-run")}
`);
}

async function main() {
  const argv = process.argv.slice(2);

  // If no CLI flags and stdin is TTY: launch TUI
  if (argv.length === 0 && process.stdin.isTTY) {
    await runInteractiveTui();
    releaseStdin();
    return;
  }

  // CLI Arguments Parsing
  let doAll = false;
  let providerArg: string | null = null;
  let customFile: string | null = null;
  let strategy: "smart" | "exact" | "first" = "smart";
  let formatStyle: FormatStyle = "smart";
  let backup = true;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      printHelp();
      return;
    }
    if (a === "--all") doAll = true;
    else if (a === "-f" || a === "--file") customFile = argv[++i];
    else if (a === "--inferencedahl" || a === "--dahl") providerArg = "inferencedahl";
    else if (a === "--tokenharbor") providerArg = "tokenharbor";
    else if (a === "--llm7io") providerArg = "llm7io";
    else if (a === "--inferbase") providerArg = "inferbase";
    else if (a === "--groqcloud") providerArg = "groqcloud";
    else if (a === "--fastrouter") providerArg = "fastrouter";
    else if (a === "--crusoe") providerArg = "crusoe";
    else if (a === "--openrouter") providerArg = "openrouter";
    else if (a === "--composite") providerArg = "composite";
    else if (a === "--cbdg") providerArg = "cbdg";
    else if (a === "--zromoonmath" || a === "--zro") providerArg = "zromoonmath";
    else if (a === "--format" || a === "--style") {
      const st = argv[++i]?.toLowerCase();
      if (st === "plain" || st === "account" || st === "smart") formatStyle = st;
    }
    else if (a === "--plain") formatStyle = "plain";
    else if (a === "--account") formatStyle = "account";
    else if (a === "--strategy" || a === "-s") {
      const s = argv[++i]?.toLowerCase();
      if (s === "smart" || s === "exact" || s === "first") strategy = s;
    }
    else if (a === "--backup") backup = true;
    else if (a === "--no-backup") backup = false;
    else if (a === "--dry-run") dryRun = true;
  }

  let filesToProcess: string[] = [];
  if (customFile) {
    if (!existsSync(resolve(process.cwd(), customFile))) {
      console.error(ui.red(`Error: File "${customFile}" tidak ditemukan!`));
      process.exit(1);
    }
    filesToProcess = [customFile];
  } else if (providerArg) {
    const p = KNOWN_PROVIDERS.find((pr) => pr.id === providerArg);
    if (!p) {
      console.error(ui.red(`Error: Provider "${providerArg}" tidak dikenal!`));
      process.exit(1);
    }
    filesToProcess = p.files.filter((f) => existsSync(resolve(process.cwd(), f)));
  } else if (doAll) {
    filesToProcess = discoverAllApiKeyFiles();
  } else {
    // If no specific flag, default to interactive
    await runInteractiveTui();
    releaseStdin();
    return;
  }

  console.log(`\n${ui.bold("API Key Deduplicator")} (strategy=${strategy}, format=${formatStyle}, backup=${backup}, dryRun=${dryRun})`);
  let totalCleaned = 0;
  let filesModified = 0;

  for (const f of filesToProcess) {
    const st = inspectFileDedupe(f, strategy, formatStyle);
    if (!st) continue;

    if (st.duplicateCount > 0) {
      console.log(
        `• ${f}: ${st.totalLines} baris → ${ui.cyan(String(st.uniqueCount))} unik (${ui.yellow(`-${st.duplicateCount} duplikat`)})`
      );
      if (st.duplicateSample.length > 0) {
        console.log(ui.dim(`  Sampel duplikat dibuang: ${st.duplicateSample.slice(0, 3).join(", ")}`));
      }

      if (!dryRun) {
        const res = applyDedupeToFile(f, st.cleanLines, backup);
        if (res.success) {
          filesModified++;
          totalCleaned += st.duplicateCount;
        } else {
          console.error(ui.red(`  Gagal menulis ${f}: ${res.error}`));
        }
      } else {
        filesModified++;
        totalCleaned += st.duplicateCount;
      }
    } else {
      console.log(`• ${f}: ${st.totalLines} baris ${ui.green("(sudah unik, tidak ada duplikat)")}`);
    }
  }

  if (dryRun) {
    console.log(ui.yellow(`\n[DRY RUN] ${totalCleaned} duplikat dari ${filesModified} file siap dibersihkan (file asli tidak diubah).`));
  } else {
    console.log(ui.green(`\n[BERHASIL] ${totalCleaned} duplikat dibersihkan dari ${filesModified} file.`));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof Cancelled) {
      console.log(ui.dim("\nDibatalkan."));
    } else {
      console.error(ui.red(`\nError: ${err.message || err}`));
    }
    releaseStdin();
    process.exit(1);
  });
}
