import fs from "node:fs";

export interface Account {
  fingerprint: string;
  apiKey?: string;
  username?: string;
}

export function loadAccounts(filePath: string): Account[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out: Account[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/[:|,;\t]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 1) continue;

    const [fingerprint, apiKey, username] = parts;
    if (!fingerprint || fingerprint.length < 8) continue;

    out.push({ fingerprint, apiKey, username });
  }
  return out;
}

export function loadProxies(filePath: string): string[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
