#!/usr/bin/env bun
/**
 * Entrim & Crusoe Bulk API Key Inspector (CLI Edition)
 * Native Bun TypeScript Runner - Zero CORS Restrictions
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

// High-fidelity terminal colors and styles without external dependencies
type ColorFormat = {
  (s?: string | number): string;
  toString(): string;
};

function createStyle(open: string, close: string = "\x1b[0m"): ColorFormat {
  const fn = (s?: string | number) => (s !== undefined && s !== null ? `${open}${s}${close}` : open);
  fn.toString = () => open;
  return fn as ColorFormat;
}

const c = {
  reset: createStyle("\x1b[0m"),
  bold: createStyle("\x1b[1m"),
  dim: createStyle("\x1b[2m"),
  italic: createStyle("\x1b[3m"),
  underline: createStyle("\x1b[4m"),

  // Foreground Colors
  red: createStyle("\x1b[38;5;196m"),
  green: createStyle("\x1b[38;5;46m"),
  yellow: createStyle("\x1b[38;5;220m"),
  blue: createStyle("\x1b[38;5;39m"),
  magenta: createStyle("\x1b[38;5;201m"),
  cyan: createStyle("\x1b[38;5;51m"),
  white: createStyle("\x1b[38;5;255m"),
  gray: createStyle("\x1b[38;5;244m"),
  darkGray: createStyle("\x1b[38;5;238m"),

  // Background Badges
  bgGreen: (s: string | number) => `\x1b[48;5;28m\x1b[38;5;255m ${s} \x1b[0m`,
  bgYellow: (s: string | number) => `\x1b[48;5;178m\x1b[38;5;16m ${s} \x1b[0m`,
  bgRed: (s: string | number) => `\x1b[48;5;160m\x1b[38;5;255m ${s} \x1b[0m`,
  bgBlue: (s: string | number) => `\x1b[48;5;25m\x1b[38;5;255m ${s} \x1b[0m`,
  bgPurple: (s: string | number) => `\x1b[48;5;93m\x1b[38;5;255m ${s} \x1b[0m`,
  bgDark: (s: string | number) => `\x1b[48;5;236m\x1b[38;5;250m ${s} \x1b[0m`,
};

interface KeyEntry {
  key: string;
  rawLine: string;
  email?: string;
  password?: string;
}

interface KeyCheckResult {
  key: string;
  entry: KeyEntry;
  status: "VALID" | "QUOTA" | "INVALID" | "ERROR";
  httpStatus: number | null;
  latencyMs: number;
  message: string;
  proxyUsed?: string;
  modelsCount?: number;
}

interface CliConfig {
  baseUrl: string;
  targetModel: string;
  mode: "chat" | "models" | "smart";
  concurrency: number;
  timeoutMs: number;
  keysFile: string;
  proxiesFile: string;
  proxyList: string[];
  outputValid: string;
  outputBad: string;
  outputCsv: string;
  limit?: number;
}

function resolveDefaultKeysFile(provider?: "fastrouter" | "crusoe" | "entrim" | "tokenharbor"): string {
  if (provider === "tokenharbor") {
    if (existsSync(resolve(process.cwd(), "akun-result-tokenharbor.txt"))) return "akun-result-tokenharbor.txt";
    if (existsSync(resolve(process.cwd(), "apikey-tokenharbor.txt"))) return "apikey-tokenharbor.txt";
    if (existsSync(resolve(process.cwd(), "tokenharbor-dataset/apikey-tokenharbor.txt"))) return "tokenharbor-dataset/apikey-tokenharbor.txt";
    return "akun-result-tokenharbor.txt";
  }
  if (provider === "fastrouter") {
    if (existsSync(resolve(process.cwd(), "apikey-fastrouter.txt"))) return "apikey-fastrouter.txt";
    if (existsSync(resolve(process.cwd(), "apikey-fastrouter"))) return "apikey-fastrouter";
    return "apikey-fastrouter.txt";
  }
  if (provider === "crusoe") {
    if (existsSync(resolve(process.cwd(), "apikey.txt"))) return "apikey.txt";
    if (existsSync(resolve(process.cwd(), "keys.txt"))) return "keys.txt";
    return "apikey.txt";
  }
  if (provider === "entrim") {
    if (existsSync(resolve(process.cwd(), "apikey-entrim.txt"))) return "apikey-entrim.txt";
    if (existsSync(resolve(process.cwd(), "apikey.txt"))) return "apikey.txt";
    return "apikey.txt";
  }
  // Fallback umum: prioritaskan akun-result-tokenharbor.txt jika ada, apikey.txt, apikey-fastrouter.txt
  if (existsSync(resolve(process.cwd(), "akun-result-tokenharbor.txt"))) return "akun-result-tokenharbor.txt";
  if (existsSync(resolve(process.cwd(), "apikey.txt"))) return "apikey.txt";
  if (existsSync(resolve(process.cwd(), "apikey-fastrouter.txt"))) return "apikey-fastrouter.txt";
  if (existsSync(resolve(process.cwd(), "keys.txt"))) return "keys.txt";
  return "apikey.txt";
}

function resolveDefaultProxiesFile(): string {
  if (existsSync(resolve(process.cwd(), "proxy-live.txt"))) return "proxy-live.txt";
  if (existsSync(resolve(process.cwd(), "proxy.txt"))) return "proxy.txt";
  if (existsSync(resolve(process.cwd(), "proxies.txt"))) return "proxies.txt";
  return "proxy-live.txt";
}

function printBanner() {
  if (process.stdout.isTTY) {
    console.clear();
  }
  console.log(`
${c.cyan("  ╔═══════════════════════════════════════════════════════════════════════════╗")}
${c.cyan("  ║")}  ${c.bold(c.white("⚡ MULTI-PROVIDER BULK API KEY INSPECTOR"))}   ${c.yellow("v2.4 (Interactive TUI)")} ${c.cyan("║")}
${c.cyan("  ║")}  ${c.dim("Crusoe • FastRouter • TokenHarbor • Entrim • OpenAI • Groq • Direct")}     ${c.cyan("║")}
${c.cyan("  ╚═══════════════════════════════════════════════════════════════════════════╝")}
`);
}

interface MenuItem<T> {
  label: string;
  badge?: string;
  desc?: string;
  value: T;
}

/**
 * Menu pemilih interaktif menggunakan tombol panah keyboard (Up / Down / Enter)
 */
async function selectMenu<T>(
  question: string,
  items: MenuItem<T>[],
  defaultIndex = 0
): Promise<T> {
  // Jika bukan terminal interaktif, kembalikan item default
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return items[defaultIndex].value;
  }

  let selectedIndex = Math.max(0, Math.min(defaultIndex, items.length - 1));
  let renderedLines = 0;

  // Sembunyikan kursor terminal selama pemilihan
  process.stdout.write("\x1b[?25l");

  function render(isFirst = false) {
    // Bersihkan baris yang dirender sebelumnya
    if (!isFirst && renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
    }

    const lines: string[] = [];
    lines.push(`${c.cyan("?")} ${c.bold(c.white(question))} ${c.dim("(Gunakan ↑ / ↓ lalu Enter)")}`);

    items.forEach((item, idx) => {
      const isSelected = idx === selectedIndex;
      const cursor = isSelected ? c.cyan("❯") : " ";
      const bullet = isSelected ? c.green("●") : c.dim("○");
      const badge = item.badge ? ` ${item.badge}` : "";
      const label = isSelected ? c.bold(c.white(item.label)) : c.gray(item.label);

      lines.push(` ${cursor} ${bullet} ${label}${badge}`);
      if (item.desc) {
        const descIndent = "      ";
        const descText = isSelected ? c.yellow(item.desc) : c.darkGray(item.desc);
        lines.push(`${descIndent}${descText}`);
      }
    });

    lines.push(""); // Spasi bawah
    process.stdout.write(lines.join("\n"));
    renderedLines = lines.length;
  }

  return new Promise<T>((resolve) => {
    render(true);

    const onKeypress = (data: Buffer) => {
      const key = data.toString();

      // Ctrl + C (Keluar secara bersih)
      if (key === "\u0003") {
        process.stdout.write("\x1b[?25h\n");
        process.exit(0);
      }

      // Tombol Panah Atas (Up Arrow) atau 'k' (vim key)
      if (key === "\u001b[A" || key === "k" || key === "K") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
        return;
      }

      // Tombol Panah Bawah (Down Arrow) atau 'j' (vim key)
      if (key === "\u001b[B" || key === "j" || key === "J") {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
        return;
      }

      // Tombol Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        // Tampilkan pilihan terpilih dalam satu baris ringkas
        if (renderedLines > 0) {
          process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        }
        console.log(
          `${c.green("✔")} ${c.bold(question)}: ${c.cyan(items[selectedIndex].label)}`
        );
        resolve(items[selectedIndex].value);
      }
    };

    function cleanup() {
      process.stdin.removeListener("data", onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {}
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // Munculkan kembali kursor
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onKeypress);
    } catch {
      cleanup();
      resolve(items[defaultIndex].value);
    }
  });
}

async function promptInput(question: string, defaultValue = ""): Promise<string> {
  if (!process.stdin.isTTY) {
    return defaultValue;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultHint = defaultValue ? c.dim(` (Default: ${defaultValue})`) : "";
  const answer = await rl.question(`${c.cyan("?")} ${c.bold(question)}${defaultHint}: `);
  rl.close();

  const trimmed = answer.trim();
  return trimmed || defaultValue;
}

function parseArguments(): Partial<CliConfig> {
  const args = process.argv.slice(2);
  const config: Partial<CliConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--fastrouter" || arg === "--fr") {
      config.baseUrl = "https://api.fastrouter.ai/api/v1";
      config.targetModel = "openai/gpt-4o-mini";
      config.mode = "chat";
      if (!config.keysFile) config.keysFile = resolveDefaultKeysFile("fastrouter");
    } else if (arg === "--tokenharbor" || arg === "--th") {
      config.baseUrl = "https://tokenharbor.ai/v1";
      config.targetModel = "deepseek-v4-flash:free";
      config.mode = "smart";
      if (!config.keysFile) config.keysFile = resolveDefaultKeysFile("tokenharbor");
      if (!config.outputValid) config.outputValid = "akun-good-tokenharbor.txt";
      if (!config.outputBad) config.outputBad = "akun-bad-tokenharbor.txt";
    } else if (arg === "--crusoe") {
      config.baseUrl = "https://api.inference.crusoecloud.com/v1";
      config.targetModel = "deepseek-ai/Deepseek-V4-Flash";
      config.mode = "smart";
      if (!config.keysFile) config.keysFile = resolveDefaultKeysFile("crusoe");
    } else if (arg === "--entrim") {
      config.baseUrl = "https://api.entrim.ai/v1";
      config.targetModel = "gpt-4o-mini";
      config.mode = "smart";
      if (!config.keysFile) config.keysFile = resolveDefaultKeysFile("entrim");
    } else if (arg === "--url" || arg === "-u") {
      config.baseUrl = next;
      i++;
    } else if (arg === "--model" || arg === "-m") {
      config.targetModel = next;
      i++;
    } else if (arg === "--keys" || arg === "-k") {
      config.keysFile = next;
      i++;
    } else if (arg === "--proxies" || arg === "--proxy" || arg === "-p") {
      if (next && !next.startsWith("-")) {
        config.proxiesFile = next;
        i++;
      } else {
        config.proxiesFile = resolveDefaultProxiesFile();
      }
    } else if (arg === "--no-proxy" || arg === "--direct") {
      config.proxiesFile = "";
    } else if (arg === "--concurrency" || arg === "-c") {
      config.concurrency = parseInt(next, 10) || 5;
      i++;
    } else if (arg === "--timeout" || arg === "-t") {
      config.timeoutMs = (parseInt(next, 10) || 12) * 1000;
      i++;
    } else if (arg === "--limit" || arg === "-l") {
      config.limit = parseInt(next, 10) || undefined;
      i++;
    } else if (arg === "--mode") {
      if (next === "chat" || next === "models" || next === "smart") {
        config.mode = next;
      }
      i++;
    } else if (arg === "--output" || arg === "--output-valid" || arg === "-o") {
      config.outputValid = next;
      i++;
    } else if (arg === "--output-bad" || arg === "--bad" || arg === "-b") {
      config.outputBad = next;
      i++;
    } else if (arg === "--csv") {
      config.outputCsv = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
${c.bold("PENGGUNAAN:")}
  bun run entrim_crusoe_key_checker_cli.ts              ${c.dim("(Mode Interaktif Navigasi Tombol Panah)")}
  bun run entrim_crusoe_key_checker_cli.ts [OPSI...]    ${c.dim("(Mode CLI Langsung)")}

${c.bold("OPSI:")}
  --tokenharbor, --th      Preset TokenHarbor AI (https://tokenharbor.ai/v1 • deepseek-v4-flash:free)
  --fastrouter, --fr       Preset otomatis untuk FastRouter AI (https://api.fastrouter.ai/api/v1)
  --crusoe                 Preset otomatis untuk Crusoe Cloud Inference
  --entrim                 Preset otomatis untuk Entrim AI
  -k, --keys <file>        File path daftar API key / akun (email:password:apikey)
  -p, --proxy [file]       Gunakan proxy pool (Opsional, Default: proxy-live.txt)
  --no-proxy, --direct     Koneksi langsung tanpa proxy (Default)
  -u, --url <url>          Base URL API (Default: TokenHarbor / Crusoe)
  -m, --model <id>         Model target ping (Default: deepseek-v4-flash:free / Deepseek-V4-Flash)
  --mode <mode>            Metode cek: "smart" (rekomendasi), "chat", "models"
  -c, --concurrency <num>  Jumlah worker simultan (Default: 5)
  -t, --timeout <sec>      Batas timeout request dalam detik (Default: 12)
  -l, --limit <num>        Batasi jumlah key yang diuji
  -o, --output <file>      File hasil simpan key/akun valid (Default: akun-good-tokenharbor.txt / valid_keys.txt)
  -b, --output-bad <file>  File hasil simpan akun/key bad (email:password:apikey) (Default: akun-bad-tokenharbor.txt / bad_keys.txt)
  --csv <file>             File hasil ekspor CSV (Default: check_results.csv)
  -h, --help               Tampilkan panduan ini

${c.bold("CONTOH:")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --tokenharbor")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --tokenharbor -k akun-result-tokenharbor.txt -c 10")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --tokenharbor --limit 5")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --fastrouter")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts -k apikey.txt")}
`);
}

function loadProxiesFromFile(filePath: string): string[] {
  if (!filePath) return [];
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) return [];

  const content = readFileSync(resolved, "utf-8");
  const lines = content.split(/[\r\n]+/);
  const validProxies: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Normalisasi: jika format IP:PORT:USER:PASS
    const parts = trimmed.split(":");
    if (parts.length === 4 && !trimmed.startsWith("http")) {
      const [ip, port, user, pass] = parts;
      validProxies.push(`http://${user}:${pass}@${ip}:${port}`);
    } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      validProxies.push(trimmed);
    } else if (trimmed.includes("@")) {
      validProxies.push(`http://${trimmed}`);
    }
  }

  return Array.from(new Set(validProxies));
}

function parseLineToKeyEntry(line: string): KeyEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }

  // Bersihkan trailing timestamp jika ada (misal format: ...|2026-10-06T...)
  let cleanLine = trimmed;
  if (trimmed.includes("|")) {
    const pipeIdx = trimmed.lastIndexOf("|");
    const potentialTs = trimmed.slice(pipeIdx + 1);
    if (potentialTs.includes("T") || potentialTs.includes("-") || potentialTs.length > 10) {
      cleanLine = trimmed.slice(0, pipeIdx).trim();
    }
  }

  // Deteksi format akun: email:password:apikey
  if (cleanLine.includes(":")) {
    const parts = cleanLine.split(":");
    if (parts.length >= 3) {
      const first = parts[0].trim();
      const last = parts[parts.length - 1].trim();
      // Format email:password:apikey
      if (first.includes("@") || last.startsWith("thk_") || last.startsWith("sk-") || last.length > 25) {
        const email = first;
        const key = last;
        const password = parts.slice(1, parts.length - 1).join(":");
        return {
          key,
          rawLine: `${email}:${password}:${key}`,
          email,
          password,
        };
      }
    }
  }

  // Fallback: line adalah plain API key
  if (cleanLine.length > 5) {
    return {
      key: cleanLine,
      rawLine: cleanLine,
    };
  }

  return null;
}

function loadKeysFromFile(filePath: string): KeyEntry[] {
  if (!filePath) return [];
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    return [];
  }
  const content = readFileSync(resolved, "utf-8");
  const rawLines = content.split(/[\r\n]+/);
  const keysMap = new Map<string, KeyEntry>();

  for (const line of rawLines) {
    const entry = parseLineToKeyEntry(line);
    if (entry && !keysMap.has(entry.key)) {
      keysMap.set(entry.key, entry);
    }
  }

  return Array.from(keysMap.values());
}

function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 9)}••••••••${key.slice(-6)}`;
}

async function verifyKey(
  entry: KeyEntry,
  config: CliConfig,
  proxyUrl?: string
): Promise<KeyCheckResult> {
  const key = entry.key;
  const cleanBase = config.baseUrl.replace(/\/+$/, "");
  const startTime = performance.now();
  const isFastRouter = cleanBase.includes("fastrouter") || key.startsWith("sk-v1-");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const fetchOptions: any = {
    signal: controller.signal,
  };

  if (proxyUrl) {
    fetchOptions.proxy = proxyUrl;
  }

  try {
    // 1. TAHAP SMART / MODELS (Cek /models terlebih dahulu: instan, akurat, hemat kuota)
    // CATATAN: FastRouter memiliki endpoint public /models yang selalu mengembalikan HTTP 200 tanpa auth.
    // Oleh karena itu, FastRouter dilewati dari tahap /models dan langsung diuji via /chat/completions.
    if (!isFastRouter && (config.mode === "smart" || config.mode === "models")) {
      try {
        const modelsResp = await fetch(`${cleanBase}/models`, {
          ...fetchOptions,
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
        });

        const latencyMs = Math.round(performance.now() - startTime);

        if (modelsResp.ok) {
          const data = (await modelsResp.json().catch(() => null)) as any;
          const count = Array.isArray(data?.data) ? data.data.length : 0;
          return {
            key,
            entry,
            status: "VALID",
            httpStatus: modelsResp.status,
            latencyMs,
            modelsCount: count,
            message: `Auth valid (${count} models terdeteksi)`,
            proxyUsed: proxyUrl,
          };
        }

        if (modelsResp.status === 429) {
          return {
            key,
            entry,
            status: "QUOTA",
            httpStatus: 429,
            latencyMs,
            message: "Rate Limit / Quota Habis (HTTP 429)",
            proxyUsed: proxyUrl,
          };
        }

        if (modelsResp.status === 402) {
          return {
            key,
            entry,
            status: "QUOTA",
            httpStatus: 402,
            latencyMs,
            message: "Insufficient Credits / Quota Habis (HTTP 402)",
            proxyUsed: proxyUrl,
          };
        }

        if (modelsResp.status === 401 || modelsResp.status === 403) {
          const errJson = (await modelsResp.json().catch(() => null)) as any;
          const msg =
            errJson?.error?.message ||
            (Array.isArray(errJson?.errors) ? errJson.errors[0] : null) ||
            "Unauthorized / Invalid API Key";
          return {
            key,
            entry,
            status: "INVALID",
            httpStatus: modelsResp.status,
            latencyMs,
            message: `Kunci Tidak Valid (${msg})`,
            proxyUsed: proxyUrl,
          };
        }

        // Jika /models tidak didukung (404/405) dan mode "models", return error
        if (config.mode === "models") {
          return {
            key,
            entry,
            status: "ERROR",
            httpStatus: modelsResp.status,
            latencyMs,
            message: `Endpoint /models mengembalikan HTTP ${modelsResp.status}`,
            proxyUsed: proxyUrl,
          };
        }
      } catch (err: any) {
        if (config.mode === "models") {
          throw err;
        }
        // Jika smart mode, fallback ke chat completions di bawah
      }
    }

    // 2. TAHAP CHAT COMPLETIONS (Untuk mode "chat", atau fallback dari "smart")
    const response = await fetch(`${cleanBase}/chat/completions`, {
      ...fetchOptions,
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: config.targetModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
    });

    const latencyMs = Math.round(performance.now() - startTime);

    if (response.ok) {
      const data = (await response.json().catch(() => null)) as any;
      const reply =
        data?.choices?.[0]?.message?.content?.trim().replace(/[\r\n]+/g, " ") ||
        "Respon inferensi berhasil";
      const snippet = reply.length > 40 ? `${reply.slice(0, 40)}...` : reply;

      return {
        key,
        entry,
        status: "VALID",
        httpStatus: response.status,
        latencyMs,
        message: `Sukses: "${snippet}"`,
        proxyUsed: proxyUrl,
      };
    }

    if (response.status === 429 || response.status === 402) {
      const errJson = (await response.json().catch(() => null)) as any;
      const msg =
        errJson?.error?.message ||
        (Array.isArray(errJson?.errors) ? errJson.errors[0] : null) ||
        (response.status === 402 ? "Insufficient Credits / Quota Habis (HTTP 402)" : "Rate Limit / Quota Habis (HTTP 429)");
      return {
        key,
        entry,
        status: "QUOTA",
        httpStatus: response.status,
        latencyMs,
        message: msg,
        proxyUsed: proxyUrl,
      };
    }

    if (response.status === 401 || response.status === 403) {
      const errJson = (await response.json().catch(() => null)) as any;
      const msg =
        errJson?.error?.message ||
        (Array.isArray(errJson?.errors) ? errJson.errors[0] : null) ||
        "Unauthorized / Invalid API Key";
      return {
        key,
        entry,
        status: "INVALID",
        httpStatus: response.status,
        latencyMs,
        message: `Kunci Tidak Dikenal (${msg})`,
        proxyUsed: proxyUrl,
      };
    }

    if (response.status === 404) {
      // Model not found - periksa apakah key sebenarnya valid via /models (HANYA jika bukan FastRouter)
      if (!isFastRouter) {
        try {
          const checkModels = await fetch(`${cleanBase}/models`, {
            ...fetchOptions,
            headers: { Authorization: `Bearer ${key}` },
          });
          if (checkModels.ok) {
            const modelsData = (await checkModels.json().catch(() => null)) as any;
            const count = Array.isArray(modelsData?.data) ? modelsData.data.length : 0;
            return {
              key,
              entry,
              status: "VALID",
              httpStatus: 200,
              latencyMs,
              modelsCount: count,
              message: `Key Aktif (Model "${config.targetModel}" 404, ${count} model lain tersedia)`,
              proxyUsed: proxyUrl,
            };
          }
        } catch {
          // Fallthrough ke error standar
        }
      }

      const errJson = (await response.json().catch(() => null)) as any;
      const msg =
        errJson?.error?.message ||
        `Model "${config.targetModel}" tidak ditemukan di server`;
      return {
        key,
        entry,
        status: "ERROR",
        httpStatus: 404,
        latencyMs,
        message: msg,
        proxyUsed: proxyUrl,
      };
    }

    const errText = await response.text().catch(() => response.statusText);
    return {
      key,
      entry,
      status: "ERROR",
      httpStatus: response.status,
      latencyMs,
      message: `HTTP ${response.status}: ${errText.slice(0, 60)}`,
      proxyUsed: proxyUrl,
    };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - startTime);
    if (err.name === "AbortError" || err.message?.includes("timeout")) {
      return {
        key,
        entry,
        status: "ERROR",
        httpStatus: null,
        latencyMs,
        message: `Timeout (> ${config.timeoutMs / 1000}s)`,
        proxyUsed: proxyUrl,
      };
    }

    return {
      key,
      entry,
      status: "ERROR",
      httpStatus: null,
      latencyMs,
      message: `Network Error: ${err.message || "Failed to connect"}`,
      proxyUsed: proxyUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runConcurrentChecker(
  keys: KeyEntry[],
  config: CliConfig
): Promise<KeyCheckResult[]> {
  const results: KeyCheckResult[] = [];
  let currentIndex = 0;
  let completed = 0;
  let proxyIdx = 0;

  const total = keys.length;
  const padding = total.toString().length;

  console.log(
    `${c.dim("┌")}${c.dim("─".repeat(88))}${c.dim("┐")}`
  );
  console.log(
    ` ${c.bold("PROGRESS LIVE INSPECTION")}`
  );
  console.log(
    `${c.dim("├")}${c.dim("─".repeat(88))}${c.dim("┤")}`
  );

  async function worker(workerId: number) {
    while (currentIndex < keys.length) {
      const index = currentIndex++;
      const currentEntry = keys[index];
      const currentKey = currentEntry.key;

      // Ambil proxy jika ada
      let currentProxy: string | undefined = undefined;
      if (config.proxyList.length > 0) {
        currentProxy = config.proxyList[proxyIdx % config.proxyList.length];
        proxyIdx++;
      }

      let res = await verifyKey(currentEntry, config, currentProxy);

      // Jika terjadi error koneksi saat memakai proxy pool, coba fallback sekali ke proxy berikutnya
      if (res.status === "ERROR" && currentProxy && config.proxyList.length > 1) {
        const altProxy = config.proxyList[proxyIdx % config.proxyList.length];
        proxyIdx++;
        const retryRes = await verifyKey(currentEntry, config, altProxy);
        if (retryRes.status !== "ERROR") {
          res = retryRes;
        }
      }

      results.push(res);
      completed++;

      // Format Baris Terminal
      const seqStr = c.dim(`[${(index + 1).toString().padStart(padding, "0")}/${total}]`);
      const masked = c.bold(maskKey(currentKey));
      const accTag = currentEntry.email ? c.dim(` (${currentEntry.email})`) : "";
      const latStr = res.latencyMs > 0 ? c.gray(`${res.latencyMs.toString().padStart(4, " ")}ms`) : c.gray("   -  ");

      let badge = "";
      let detailMsg = "";

      switch (res.status) {
        case "VALID":
          badge = c.bgGreen("✓ ACTIVE");
          detailMsg = c.green(res.message);
          break;
        case "QUOTA":
          badge = c.bgYellow("! QUOTA ");
          detailMsg = c.yellow(res.message);
          break;
        case "INVALID":
          badge = c.bgRed("✗ DEAD  ");
          detailMsg = c.red(res.message);
          break;
        case "ERROR":
          badge = c.bgDark("⚠ ERROR ");
          detailMsg = c.gray(res.message);
          break;
      }

      const proxyTag = res.proxyUsed
        ? c.dim(` (${res.proxyUsed.replace(/http:\/\/.*@/, "http://")})`)
        : "";

      console.log(
        ` ${seqStr} ${badge} ${masked}${accTag} ${latStr} ── ${detailMsg}${proxyTag}`
      );
    }
  }

  // Jalankan pool sesuai concurrency
  const workerCount = Math.min(config.concurrency, keys.length);
  const workers = Array.from({ length: workerCount }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(
    `${c.dim("└")}${c.dim("─".repeat(88))}${c.dim("┘")}\n`
  );

  return results;
}

function printSummary(results: KeyCheckResult[], totalDurationMs: number, config: CliConfig) {
  const total = results.length;
  const valid = results.filter((r) => r.status === "VALID");
  const quota = results.filter((r) => r.status === "QUOTA");
  const invalid = results.filter((r) => r.status === "INVALID");
  const error = results.filter((r) => r.status === "ERROR");
  const bad = results.filter((r) => r.status !== "VALID");

  const validPct = total > 0 ? ((valid.length / total) * 100).toFixed(1) : "0.0";
  const durationSec = (totalDurationMs / 1000).toFixed(2);
  const avgLatency =
    results.length > 0
      ? Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length)
      : 0;

  console.log(
    `${c.bold(c.white("╔═══════════════════════════════════════════════════════════════════════════╗"))}`
  );
  console.log(
    `║  ${c.bold(c.cyan("LAPORAN HASIL PENGECEKAN"))}                                                ║`
  );
  console.log(
    `${c.bold(c.white("╠═══════════════════════════════════════════════════════════════════════════╣"))}`
  );
  console.log(
    `║  Total Diuji         : ${c.bold(c.white(total.toString().padEnd(6)))}  ║  Waktu Eksekusi   : ${c.white(`${durationSec}s`.padEnd(10))} ║`
  );
  console.log(
    `║  ${c.green("● Aktif (Good/Valid)")} : ${c.bold(c.green(valid.length.toString().padEnd(6)))}  ║  Rata-rata Latensi: ${c.white(`${avgLatency}ms`.padEnd(10))} ║`
  );
  console.log(
    `║  ${c.yellow("▲ Limit / Habis Kuota")} : ${c.bold(c.yellow(quota.length.toString().padEnd(6)))}  ║  Rasio Keberhasilan: ${c.bold(c.green(`${validPct}%`.padEnd(9)))} ║`
  );
  console.log(
    `║  ${c.red("✕ Mati (Invalid 401)")}: ${c.bold(c.red(invalid.length.toString().padEnd(6)))}  ║  Gagal Koneksi    : ${c.gray(error.length.toString().padEnd(10))} ║`
  );
  console.log(
    `${c.bold(c.white("╚═══════════════════════════════════════════════════════════════════════════╝"))}`
  );

  // Daftar Key / Akun Valid
  if (valid.length > 0) {
    console.log(`\n${c.bold(c.green("🔑 DAFTAR KEY / AKUN VALID (GOOD):"))}`);
    console.log(c.dim("─".repeat(70)));
    valid.slice(0, 15).forEach((item, i) => {
      const emailHint = item.entry.email ? c.dim(` (${item.entry.email})`) : "";
      console.log(`  ${c.cyan((i + 1).toString().padStart(2, "0") + ".")} ${c.bold(c.white(item.key))}${emailHint}`);
    });
    if (valid.length > 15) {
      console.log(`  ${c.dim(`... dan ${valid.length - 15} lainnya (lihat ${config.outputValid})`)}`);
    }
    console.log(c.dim("─".repeat(70)));
  }

  // Daftar Key / Akun Gagal (BAD)
  if (bad.length > 0) {
    console.log(`\n${c.bold(c.yellow("⚠ DAFTAR AKUN / KEY GAGAL (BAD):"))}`);
    console.log(c.dim("─".repeat(70)));
    bad.slice(0, 10).forEach((item, i) => {
      console.log(`  ${c.yellow((i + 1).toString().padStart(2, "0") + ".")} ${c.red(item.entry.rawLine)} ── ${c.dim(item.message)}`);
    });
    if (bad.length > 10) {
      console.log(`  ${c.dim(`... dan ${bad.length - 10} akun/key gagal lainnya (lihat ${config.outputBad})`)}`);
    }
    console.log(c.dim("─".repeat(70)));

    const freeModelsDisabledCount = bad.filter((item) =>
      item.message.toLowerCase().includes("free models are turned off") ||
      item.message.toLowerCase().includes("free_models_disabled")
    ).length;
    if (freeModelsDisabledCount > 0) {
      console.log(
        `\n${c.bold(c.cyan("💡 TIP TOKENHARBOR:"))} Terdeteksi ${c.bold(c.yellow(freeModelsDisabledCount))} akun dengan Free Models nonaktif.`
      );
      console.log(
        `   Aktifkan kembali otomatis dengan: ${c.bold(c.green("bun run tokenharbor -- --re-enable-free"))} atau via ${c.bold(c.green("bun run start"))} (pilih Re-enable Free Models)!`
      );
    }
  }
}

function saveOutputs(results: KeyCheckResult[], config: CliConfig) {
  const valid = results.filter((r) => r.status === "VALID");
  const bad = results.filter((r) => r.status !== "VALID");

  // 1. Simpan Good / Valid results
  if (valid.length > 0) {
    const validLines = valid.map((r) => r.entry.rawLine).join("\n") + "\n";
    writeFileSync(config.outputValid, validLines, "utf-8");
    console.log(
      `${c.green("✔")} ${c.bold(valid.length)} Akun/Key aktif (GOOD) disimpan ke: ${c.bold(c.cyan(config.outputValid))}`
    );

    // Jika format input adalah akun (email:password:key), simpan juga file plain keys murni jika outputValid bukan valid_keys.txt
    const hasAccountInfo = valid.some((r) => !!r.entry.email);
    if (hasAccountInfo && config.outputValid !== "valid_keys.txt") {
      const plainKeys = valid.map((r) => r.key).join("\n") + "\n";
      const plainKeyFile = config.keysFile.includes("tokenharbor")
        ? "apikey-good-tokenharbor.txt"
        : "valid_keys.txt";
      writeFileSync(plainKeyFile, plainKeys, "utf-8");
      console.log(
        `${c.green("✔")} ${c.bold(valid.length)} Plain API key valid juga disimpan ke: ${c.bold(c.cyan(plainKeyFile))}`
      );
    }
  }

  // 2. Simpan Bad / Invalid results (format email:password:apikey jika ada akunnya, atau plain key jika tidak)
  if (bad.length > 0 && config.outputBad) {
    const badLines = bad.map((r) => r.entry.rawLine).join("\n") + "\n";
    writeFileSync(config.outputBad, badLines, "utf-8");
    console.log(
      `${c.yellow("✔")} ${c.bold(bad.length)} Akun/Key gagal (BAD) dipisahkan ke: ${c.bold(c.yellow(config.outputBad))}`
    );
  }

  // 3. Simpan CSV detail
  const hasAccountInfo = results.some((r) => !!r.entry.email);
  const csvHeaders = hasAccountInfo
    ? "Email,Password,Key,Status,HTTP_Code,Latency_ms,Message,Proxy\n"
    : "Key,Status,HTTP_Code,Latency_ms,Message,Proxy\n";
  const csvRows = results
    .map((r) => {
      const esc = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
      if (hasAccountInfo) {
        return `${esc(r.entry.email || "")},${esc(r.entry.password || "")},${esc(r.key)},"${r.status}",${r.httpStatus || 0},${r.latencyMs},${esc(r.message)},${esc(r.proxyUsed || "")}`;
      }
      return `${esc(r.key)},"${r.status}",${r.httpStatus || 0},${r.latencyMs},${esc(r.message)},${esc(r.proxyUsed || "")}`;
    })
    .join("\n");

  writeFileSync(config.outputCsv, csvHeaders + csvRows, "utf-8");
  console.log(
    `${c.green("✔")} Laporan lengkap CSV berhasil diekspor ke: ${c.bold(c.cyan(config.outputCsv))}`
  );
}

async function main() {
  printBanner();

  const cliArgs = parseArguments();
  const hasCliFlags = Object.keys(cliArgs).length > 0;

  const defaultKeys = resolveDefaultKeysFile();
  const defaultProxies = resolveDefaultProxiesFile();

  // Konfigurasi Standar
  let config: CliConfig = {
    baseUrl: cliArgs.baseUrl || "https://api.inference.crusoecloud.com/v1",
    targetModel: cliArgs.targetModel || "deepseek-ai/Deepseek-V4-Flash",
    mode: cliArgs.mode || "smart",
    concurrency: cliArgs.concurrency || 5,
    timeoutMs: cliArgs.timeoutMs || 12000,
    keysFile: cliArgs.keysFile || defaultKeys,
    proxiesFile: cliArgs.proxiesFile !== undefined ? cliArgs.proxiesFile : "",
    proxyList: [],
    outputValid: cliArgs.outputValid || (cliArgs.baseUrl?.includes("tokenharbor") ? "akun-good-tokenharbor.txt" : "valid_keys.txt"),
    outputBad: cliArgs.outputBad || (cliArgs.baseUrl?.includes("tokenharbor") ? "akun-bad-tokenharbor.txt" : "bad_keys.txt"),
    outputCsv: cliArgs.outputCsv || "check_results.csv",
    limit: cliArgs.limit,
  };

  // JIKA TIDAK ADA FLAG CLI: Jalankan Menu Interaktif Tombol Panah (Arrow Key TUI)
  if (!hasCliFlags) {
    console.log(`${c.bold(c.white("PANDUAN INTERAKTIF:"))} Konfigurasikan pengujian Anda dengan tombol panah.\n`);

    // 1. Pilih Provider & Endpoint
    interface ProviderPreset {
      url: string;
      model: string;
      mode: "chat" | "models" | "smart";
      defaultKeysFile?: string;
      outputValid?: string;
      outputBad?: string;
    }

    const providerChoice = await selectMenu<ProviderPreset | "custom">(
      "Pilih Target Provider API",
      [
        {
          label: "TokenHarbor AI",
          badge: c.bgGreen("Free Models"),
          desc: "https://tokenharbor.ai/v1 • deepseek-v4-flash:free • Auto parsing email:password:key",
          value: {
            url: "https://tokenharbor.ai/v1",
            model: "deepseek-v4-flash:free",
            mode: "smart",
            defaultKeysFile: resolveDefaultKeysFile("tokenharbor"),
            outputValid: "akun-good-tokenharbor.txt",
            outputBad: "akun-bad-tokenharbor.txt",
          },
        },
        {
          label: "FastRouter AI",
          badge: c.bgGreen("Kredit $1"),
          desc: "https://api.fastrouter.ai/api/v1 • Model: openai/gpt-4o-mini",
          value: {
            url: "https://api.fastrouter.ai/api/v1",
            model: "openai/gpt-4o-mini",
            mode: "chat",
            defaultKeysFile: resolveDefaultKeysFile("fastrouter"),
          },
        },
        {
          label: "Crusoe Cloud Inference",
          badge: c.bgBlue("Rekomendasi"),
          desc: "https://api.inference.crusoecloud.com/v1 • Model: deepseek-ai/Deepseek-V4-Flash",
          value: {
            url: "https://api.inference.crusoecloud.com/v1",
            model: "deepseek-ai/Deepseek-V4-Flash",
            mode: "smart",
            defaultKeysFile: resolveDefaultKeysFile("crusoe"),
          },
        },
        {
          label: "Entrim AI",
          badge: c.bgPurple("OpenAI Compatible"),
          desc: "https://api.entrim.ai/v1 • Model: gpt-4o-mini",
          value: {
            url: "https://api.entrim.ai/v1",
            model: "gpt-4o-mini",
            mode: "smart",
            defaultKeysFile: resolveDefaultKeysFile("entrim"),
          },
        },
        {
          label: "OpenAI Official",
          desc: "https://api.openai.com/v1 • Model: gpt-4o-mini",
          value: {
            url: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            mode: "smart",
            defaultKeysFile: resolveDefaultKeysFile("crusoe"),
          },
        },
        {
          label: "Groq Cloud Fast Inference",
          desc: "https://api.groq.com/openai/v1 • Model: llama-3.3-70b-versatile",
          value: {
            url: "https://api.groq.com/openai/v1",
            model: "llama-3.3-70b-versatile",
            mode: "chat",
            defaultKeysFile: resolveDefaultKeysFile("crusoe"),
          },
        },
        {
          label: "Kustom Endpoint (Ketik Manual)",
          desc: "Masukkan Base URL dan ID Model target sendiri",
          value: "custom",
        },
      ],
      0
    );

    if (providerChoice === "custom") {
      config.baseUrl = await promptInput(
        "Masukkan Base URL API",
        "https://api.inference.crusoecloud.com/v1"
      );
      config.targetModel = await promptInput(
        "Masukkan ID Model Target Ping",
        "deepseek-ai/Deepseek-V4-Flash"
      );
    } else {
      config.baseUrl = providerChoice.url;
      config.targetModel = providerChoice.model;
      config.mode = providerChoice.mode;
      if (providerChoice.defaultKeysFile && !cliArgs.keysFile) {
        config.keysFile = providerChoice.defaultKeysFile;
      }
      if (providerChoice.outputValid && !cliArgs.outputValid) {
        config.outputValid = providerChoice.outputValid;
      }
      if (providerChoice.outputBad && !cliArgs.outputBad) {
        config.outputBad = providerChoice.outputBad;
      }
    }

    // 2. Pilih Mode Uji
    const defaultModeIndex = config.baseUrl.includes("fastrouter") ? 1 : 0;
    config.mode = await selectMenu<"smart" | "chat" | "models">(
      "Pilih Metode Pengujian",
      [
        {
          label: "Smart Mode (/models check + completions fallback)",
          badge: c.bgGreen("Paling Efisien"),
          desc: "Cek token via endpoint models (hemat kuota & cepat), fallback ke chat jika perlu",
          value: "smart",
        },
        {
          label: "Direct Chat Ping (/chat/completions)",
          badge: config.baseUrl.includes("fastrouter") ? c.bgGreen("Wajib FastRouter") : undefined,
          desc: "Kirim pesan 1-kata untuk verifikasi inferensi live secara langsung",
          value: "chat",
        },
        {
          label: "Quick Auth Saja (/models)",
          desc: "Hanya cek validitas token tanpa mengonsumsi kuota inferensi (tidak untuk FastRouter)",
          value: "models",
        },
      ],
      defaultModeIndex
    );

    // 3. Pilih Concurrency
    config.concurrency = await selectMenu<number>(
      "Pilih Kecepatan / Worker Simultan",
      [
        {
          label: "5 Worker Paralel",
          badge: c.bgBlue("Standar"),
          desc: "Kecepatan optimal & stabil untuk koneksi laptop rumahan",
          value: 5,
        },
        {
          label: "10 Worker Paralel",
          badge: c.bgYellow("Cepat"),
          desc: "Pengecekan agresif untuk ratusan key sekaligus",
          value: 10,
        },
        {
          label: "2 Worker Paralel",
          desc: "Sangat santai dan minim risiko terkena IP rate limit",
          value: 2,
        },
        {
          label: "Kustom Jumlah Worker...",
          desc: "Tentukan angka thread sendiri",
          value: -1,
        },
      ],
      0
    );

    if (config.concurrency === -1) {
      const customConc = await promptInput("Masukkan jumlah thread (1 - 30)", "5");
      config.concurrency = Math.max(1, Math.min(parseInt(customConc, 10) || 5, 30));
    }

    // 4. Pilih Opsi Proxy (Opsional)
    const detectedProxiesCount = existsSync(defaultProxies)
      ? loadProxiesFromFile(defaultProxies).length
      : 0;

    const proxyMode = await selectMenu<"direct" | "file" | "custom">(
      "Pilih Rute Jaringan (Proxy Opsional)",
      [
        {
          label: "Koneksi Langsung (Direct Laptop - Tanpa Proxy)",
          badge: c.bgGreen("Rekomendasi"),
          desc: "Paling cepat, latensi rendah, langsung terhubung ke upstream",
          value: "direct",
        },
        ...(detectedProxiesCount > 0
          ? [
              {
                label: `Gunakan Proxy Pool dari ${defaultProxies}`,
                badge: c.bgBlue(`${detectedProxiesCount} proxy live`),
                desc: `Muat ${detectedProxiesCount} proxy dari ${defaultProxies} untuk rotasi Round-Robin`,
                value: "file" as const,
              },
            ]
          : []),
        {
          label: "Kustom File Proxy...",
          desc: "Tentukan path file proxy yang lain (format IP:PORT atau URL)",
          value: "custom",
        },
      ],
      0
    );

    if (proxyMode === "direct") {
      config.proxiesFile = "";
    } else if (proxyMode === "file") {
      config.proxiesFile = defaultProxies;
    } else if (proxyMode === "custom") {
      const customProxyFile = await promptInput(
        "File path daftar proxy",
        defaultProxies
      );
      config.proxiesFile = customProxyFile;
    }

    console.log(); // Blank line divider
  }

  // Muat Keys dari file target
  let keys = loadKeysFromFile(config.keysFile);

  // Jika file keys belum ada atau kosong, beri panduan interaktif
  if (keys.length === 0) {
    console.log(
      `${c.yellow("⚠")} File ${c.bold(config.keysFile)} belum ditemukan atau kosong.\n`
    );

    const inputMethod = await selectMenu<"paste" | "specify_path" | "create_sample">(
      "Bagaimana Anda ingin memasukkan API Key?",
      [
        {
          label: "Ketik / Tentukan path file apikey secara manual",
          desc: "Misal: apikey.txt atau path absolut",
          value: "specify_path",
        },
        {
          label: "Tempel (Paste) API Key langsung di terminal sekarang",
          desc: "Input langsung satu atau banyak key sekaligus",
          value: "paste",
        },
        {
          label: `Buatkan file template ${config.keysFile} otomatis`,
          desc: "Membuat file siap edit dengan contoh format",
          value: "create_sample",
        },
      ],
      0
    );

    if (inputMethod === "specify_path") {
      const manualPath = await promptInput("Masukkan path file API Key", "apikey.txt");
      config.keysFile = manualPath;
      keys = loadKeysFromFile(config.keysFile);
      if (keys.length === 0) {
        console.error(c.red(`File ${manualPath} tidak ditemukan atau tidak berisi key yang valid!`));
        process.exit(1);
      }
    } else if (inputMethod === "paste") {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log(
        c.dim("\nTempel API Key Anda di bawah ini (tekan ENTER 2x bila selesai):")
      );
      const inputKeys: string[] = [];
      let emptyCount = 0;

      while (true) {
        const line = await rl.question("");
        if (line.trim() === "") {
          emptyCount++;
          if (emptyCount >= 1 && inputKeys.length > 0) break;
        } else {
          emptyCount = 0;
          inputKeys.push(line.trim());
        }
      }
      writeFileSync(config.keysFile, inputKeys.join("\n") + "\n", "utf-8");
      keys = loadKeysFromFile(config.keysFile);
      console.log(`${c.green("✔")} ${keys.length} key berhasil disimpan ke ${config.keysFile}!\n`);
      rl.close();
    } else {
      const sampleContent = `# Masukkan API Key Anda di bawah ini (satu per baris):
# Format: email:password:apikey ATAU apikey saja
swiftcedar749@huzt.my.id:torabikA1###########:thk_live_FTu1P_w16ctoHILbjdRg8mpY8aXBch12pT59enkH6cD_H0D-ut5Glkuixr8NUwK7
# sk-v1-contohkey12345
`;
      writeFileSync(config.keysFile, sampleContent, "utf-8");
      console.log(`${c.green("✔")} File ${c.bold(config.keysFile)} telah dibuat!`);
      console.log(
        `${c.cyan("→")} Silakan isi key Anda di dalam ${c.bold(config.keysFile)} lalu jalankan kembali:\n  ${c.bold(c.white("bun run entrim_crusoe_key_checker_cli.ts"))}\n`
      );
      process.exit(0);
    }
  }

  // Auto-deteksi format key jika flag --url tidak ditentukan secara eksplisit
  if (keys.length > 0 && !cliArgs.baseUrl) {
    const hasTokenHarborKeys = keys.some(
      (k) => k.key.startsWith("thk_") || k.key.startsWith("thk_live_") || k.rawLine.includes("tokenharbor")
    );
    const hasFastRouterKeys = keys.some((k) => k.key.startsWith("sk-v1-"));

    if (hasTokenHarborKeys && !config.baseUrl.includes("tokenharbor")) {
      console.log(
        `${c.cyan("ℹ")} Format TokenHarbor (${c.bold("thk_live_...")}) terdeteksi! Mengalihkan target otomatis ke ${c.bold(c.green("TokenHarbor AI"))} (${c.yellow("deepseek-v4-flash:free")})\n`
      );
      config.baseUrl = "https://tokenharbor.ai/v1";
      config.targetModel = "deepseek-v4-flash:free";
      config.mode = "smart";
      if (!cliArgs.outputValid) config.outputValid = "akun-good-tokenharbor.txt";
      if (!cliArgs.outputBad) config.outputBad = "akun-bad-tokenharbor.txt";
    } else if (hasFastRouterKeys && !config.baseUrl.includes("fastrouter")) {
      console.log(
        `${c.cyan("ℹ")} Format key ${c.bold("sk-v1-...")} terdeteksi! Mengalihkan target otomatis ke ${c.bold(c.green("FastRouter AI"))} (${c.yellow("openai/gpt-4o-mini")})\n`
      );
      config.baseUrl = "https://api.fastrouter.ai/api/v1";
      config.targetModel = "openai/gpt-4o-mini";
      config.mode = "chat";
    }
  }

  // Terapkan limit jika ditentukan
  if (config.limit && config.limit > 0 && keys.length > config.limit) {
    keys = keys.slice(0, config.limit);
  }

  // Muat Proxies jika diaktifkan (opsional)
  if (config.proxiesFile) {
    config.proxyList = loadProxiesFromFile(config.proxiesFile);
    if (config.proxyList.length === 0) {
      console.log(`${c.yellow("⚠")} File proxy "${config.proxiesFile}" tidak ditemukan atau kosong. Beralih ke direct connection.\n`);
    }
  }

  // Tampilkan Ringkasan Sesi
  console.log(`${c.bold("⚙  KONFIGURASI SESI:")}`);
  console.log(`   ${c.dim("•")} Base URL     : ${c.cyan(config.baseUrl)}`);
  console.log(`   ${c.dim("•")} Target Model : ${c.yellow(config.targetModel)}`);
  console.log(`   ${c.dim("•")} Mode Uji     : ${c.green(config.mode.toUpperCase())}`);
  console.log(`   ${c.dim("•")} Concurrency  : ${c.white(config.concurrency)} thread simultan`);
  console.log(`   ${c.dim("•")} File Key     : ${c.cyan(config.keysFile)} (${c.bold(c.white(keys.length.toString()))} keys)`);
  if (config.outputValid) {
    console.log(`   ${c.dim("•")} Output Good  : ${c.green(config.outputValid)}`);
  }
  if (config.outputBad) {
    console.log(`   ${c.dim("•")} Output Bad   : ${c.yellow(config.outputBad)}`);
  }
  console.log(
    `   ${c.dim("•")} Jaringan     : ${
      config.proxyList.length > 0
        ? c.green(`${config.proxyList.length} proxy aktif (${config.proxiesFile})`)
        : c.cyan("Direct Connection (Tanpa Proxy)")
    }\n`
  );

  // Jalankan Pengecekan
  const startTime = performance.now();
  const results = await runConcurrentChecker(keys, config);
  const totalDuration = performance.now() - startTime;

  // Tampilkan Ringkasan & Simpan File
  printSummary(results, totalDuration, config);
  saveOutputs(results, config);
}

// Eksekusi Program Utama
main().catch((err) => {
  console.error(c.red(`Fatal Error: ${err.message}`));
  process.exit(1);
});