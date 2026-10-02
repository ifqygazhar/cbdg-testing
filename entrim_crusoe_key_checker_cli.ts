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

interface KeyCheckResult {
  key: string;
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
  outputCsv: string;
  limit?: number;
}

function resolveDefaultKeysFile(provider?: "fastrouter" | "crusoe" | "entrim"): string {
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
  // Fallback umum: prioritaskan apikey.txt jika ada, lalu apikey-fastrouter.txt
  if (existsSync(resolve(process.cwd(), "apikey-fastrouter.txt")) && !existsSync(resolve(process.cwd(), "apikey.txt"))) {
    return "apikey-fastrouter.txt";
  }
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
${c.cyan("  ║")}  ${c.bold(c.white("⚡ MULTI-PROVIDER BULK API KEY INSPECTOR"))}   ${c.yellow("v2.3 (Interactive TUI)")} ${c.cyan("║")}
${c.cyan("  ║")}  ${c.dim("Crusoe • FastRouter • Entrim • OpenAI • Groq • Direct Upstream")}     ${c.cyan("║")}
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
    } else if (arg === "--output" || arg === "-o") {
      config.outputValid = next;
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
  --fastrouter, --fr       Preset otomatis untuk FastRouter AI (https://api.fastrouter.ai/api/v1)
  --crusoe                 Preset otomatis untuk Crusoe Cloud Inference
  --entrim                 Preset otomatis untuk Entrim AI
  -k, --keys <file>        File path daftar API key (Default: apikey-fastrouter.txt / apikey.txt)
  -p, --proxy [file]       Gunakan proxy pool (Opsional, Default: proxy-live.txt)
  --no-proxy, --direct     Koneksi langsung tanpa proxy (Default)
  -u, --url <url>          Base URL API (Default: Crusoe Cloud Inference)
  -m, --model <id>         Model target ping (Default: deepseek-ai/Deepseek-V4-Flash)
  --mode <mode>            Metode cek: "smart" (rekomendasi), "chat", "models"
  -c, --concurrency <num>  Jumlah worker simultan (Default: 5)
  -t, --timeout <sec>      Batas timeout request dalam detik (Default: 12)
  -l, --limit <num>        Batasi jumlah key yang diuji
  -o, --output <file>      File hasil simpan key valid (Default: valid_keys.txt)
  --csv <file>             File hasil ekspor CSV (Default: check_results.csv)
  -h, --help               Tampilkan panduan ini

${c.bold("CONTOH:")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --fastrouter")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts --fastrouter -k apikey-fastrouter.txt")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts -k apikey.txt")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts -k apikey.txt -p proxy-live.txt -c 10")}
  ${c.cyan("bun run entrim_crusoe_key_checker_cli.ts -k apikey.txt --limit 10")}
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

function loadKeysFromFile(filePath: string): string[] {
  if (!filePath) return [];
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    return [];
  }
  const content = readFileSync(resolved, "utf-8");
  const rawLines = content.split(/[\r\n]+/);
  const keysSet = new Set<string>();

  for (const line of rawLines) {
    const trimmed = line.trim();
    // Abaikan komentar dan baris kosong
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("//") && trimmed.length > 5) {
      keysSet.add(trimmed);
    }
  }

  return Array.from(keysSet);
}

function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 9)}••••••••${key.slice(-6)}`;
}

async function verifyKey(
  key: string,
  config: CliConfig,
  proxyUrl?: string
): Promise<KeyCheckResult> {
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
            status: "QUOTA",
            httpStatus: 429,
            latencyMs,
            message: "Rate Limit / Quota Habis (HTTP 429)",
            proxyUsed: proxyUrl,
          };
        }

        if (modelsResp.status === 401 || modelsResp.status === 403) {
          const errJson = (await modelsResp.json().catch(() => null)) as any;
          const msg =
            errJson?.error?.message ||
            (Array.isArray(errJson?.errors) ? errJson.errors[0] : null) ||
            "Unauthorized";
          return {
            key,
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
        "Unauthorized";
      return {
        key,
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
        status: "ERROR",
        httpStatus: null,
        latencyMs,
        message: `Timeout (> ${config.timeoutMs / 1000}s)`,
        proxyUsed: proxyUrl,
      };
    }

    return {
      key,
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
  keys: string[],
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
      const currentKey = keys[index];

      // Ambil proxy jika ada
      let currentProxy: string | undefined = undefined;
      if (config.proxyList.length > 0) {
        currentProxy = config.proxyList[proxyIdx % config.proxyList.length];
        proxyIdx++;
      }

      let res = await verifyKey(currentKey, config, currentProxy);

      // Jika terjadi error koneksi saat memakai proxy pool, coba fallback sekali ke proxy berikutnya
      if (res.status === "ERROR" && currentProxy && config.proxyList.length > 1) {
        const altProxy = config.proxyList[proxyIdx % config.proxyList.length];
        proxyIdx++;
        const retryRes = await verifyKey(currentKey, config, altProxy);
        if (retryRes.status !== "ERROR") {
          res = retryRes;
        }
      }

      results.push(res);
      completed++;

      // Format Baris Terminal
      const seqStr = c.dim(`[${(index + 1).toString().padStart(padding, "0")}/${total}]`);
      const masked = c.bold(maskKey(currentKey));
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
        ` ${seqStr} ${badge} ${masked} ${latStr} ── ${detailMsg}${proxyTag}`
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

function printSummary(results: KeyCheckResult[], totalDurationMs: number) {
  const total = results.length;
  const valid = results.filter((r) => r.status === "VALID");
  const quota = results.filter((r) => r.status === "QUOTA");
  const invalid = results.filter((r) => r.status === "INVALID");
  const error = results.filter((r) => r.status === "ERROR");

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
    `║  Total Key Diuji     : ${c.bold(c.white(total.toString().padEnd(6)))}  ║  Waktu Eksekusi   : ${c.white(`${durationSec}s`.padEnd(10))} ║`
  );
  console.log(
    `║  ${c.green("● Key Aktif (Valid)")}  : ${c.bold(c.green(valid.length.toString().padEnd(6)))}  ║  Rata-rata Latensi: ${c.white(`${avgLatency}ms`.padEnd(10))} ║`
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

  // Tap-to-copy friendly list printed directly in terminal
  if (valid.length > 0) {
    console.log(`\n${c.bold(c.green("🔑 DAFTAR KEY VALID (Siap Langsung Disalin):"))}`);
    console.log(c.dim("─".repeat(70)));
    valid.forEach((item, i) => {
      console.log(`  ${c.cyan((i + 1).toString().padStart(2, "0") + ".")} ${c.bold(c.white(item.key))}`);
    });
    console.log(c.dim("─".repeat(70)));
  }
}

function saveOutputs(results: KeyCheckResult[], config: CliConfig) {
  const valid = results.filter((r) => r.status === "VALID");

  // 1. Simpan valid keys file (plain text, 1 per baris)
  if (valid.length > 0) {
    const validLines = valid.map((r) => r.key).join("\n") + "\n";
    writeFileSync(config.outputValid, validLines, "utf-8");
    console.log(
      `${c.green("✔")} ${c.bold(valid.length)} Key aktif berhasil disimpan ke: ${c.bold(c.cyan(config.outputValid))}`
    );
  }

  // 2. Simpan CSV detail
  const csvHeaders = "Key,Status,HTTP_Code,Latency_ms,Message,Proxy\n";
  const csvRows = results
    .map(
      (r) =>
        `"${r.key}","${r.status}",${r.httpStatus || 0},${r.latencyMs},"${r.message.replace(/"/g, '""')}","${r.proxyUsed || ""}"`
    )
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
    outputValid: cliArgs.outputValid || "valid_keys.txt",
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
    }

    const providerChoice = await selectMenu<ProviderPreset | "custom">(
      "Pilih Target Provider API",
      [
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
      keys = Array.from(new Set(inputKeys.filter((k) => k.length > 5)));
      writeFileSync(config.keysFile, keys.join("\n") + "\n", "utf-8");
      console.log(`${c.green("✔")} ${keys.length} key berhasil disimpan ke ${config.keysFile}!\n`);
      rl.close();
    } else {
      const sampleContent = `# Masukkan API Key Anda di bawah ini (satu per baris):
XCtEqqnHSnC61UQzncdYLw_2a_10_DlK6fSh883wXx8Ss9cV5SevuVspzkvcJ7rKgEMR9r3MXs4eODNfeq
# sk-entrim-contohkey12345
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
    const hasFastRouterKeys = keys.some((k) => k.startsWith("sk-v1-"));
    if (hasFastRouterKeys && !config.baseUrl.includes("fastrouter")) {
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
  printSummary(results, totalDuration);
  saveOutputs(results, config);
}

// Eksekusi Program Utama
main().catch((err) => {
  console.error(c.red(`Fatal Error: ${err.message}`));
  process.exit(1);
});