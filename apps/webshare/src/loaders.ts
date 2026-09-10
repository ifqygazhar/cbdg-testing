// ── Seed loaders (gsuite accounts + optional proxies) ──────────────
import fs from "node:fs";

export interface GsuiteAccount {
  email: string;
  password: string;
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

// proxy.txt   →  (scheme://)host:port or http://user:pass@host:port (optional)
export function loadProxies(file: string): ProxySeed[] {
  const out: ProxySeed[] = [];
  for (const line of readLines(file)) {
    try {
      const u = new URL(line.includes("://") ? line : `http://${line}`);
      // require a port (or embedded credentials) — hammers down entries like
      // "http://junk" that URL parses into a valid-looking bare host.
      if (!u.port && !u.username) throw new Error("no port");
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