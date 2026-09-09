// ── Seed loaders ───────────────────────────────────────────────────
import fs from "node:fs";

export interface GsuiteAccount {
  email: string;
  password: string;
  raw: string;
}
export interface VccCard {
  cardNumber: string;
  expiry: string; // MM/YY or MM/YYYY (kept raw; validated)
  cvv: string;
  raw: string;
}
export interface ProxySeed {
  server: string; // e.g. http://host:port
  raw: string;
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// gsuite.txt   →  email:password
export function loadAccounts(file: string): GsuiteAccount[] {
  const out: GsuiteAccount[] = [];
  for (const line of readLines(file)) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      console.warn(`[loaders] skip bad gsuite line: ${line}`);
      continue;
    }
    out.push({
      email: line.slice(0, idx).trim(),
      password: line.slice(idx + 1).trim(),
      raw: line,
    });
  }
  return out;
}

// vcc.txt   →  card number | exp date | cvv
const EXPIRY_RE = /^\d{2}\/\d{2}(?:\d{2})?$/;
export function loadCards(file: string): VccCard[] {
  const out: VccCard[] = [];
  for (const line of readLines(file)) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3 || !EXPIRY_RE.test(parts[1]) || !/^\d{3,4}$/.test(parts[2])) {
      console.warn(`[loaders] skip bad vcc line: ${line}`);
      continue;
    }
    out.push({ cardNumber: parts[0], expiry: parts[1], cvv: parts[2], raw: line });
  }
  return out;
}

// proxy.txt   →  (scheme://)host:port or http://user:pass@host:port
export function loadProxies(file: string): ProxySeed[] {
  const out: ProxySeed[] = [];
  for (const line of readLines(file)) {
    try {
      const u = new URL(line.includes("://") ? line : `http://${line}`);
      out.push({
        server: `${u.protocol}//${u.host}`,
        raw: line,
      });
    } catch {
      console.warn(`[loaders] skip bad proxy line: ${line}`);
    }
  }
  return out;
}