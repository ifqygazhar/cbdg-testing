// ── Loaders for accounts and proxies ──────────────────────────────
import fs from "node:fs";

export interface Account {
  email: string;
  password?: string;
  recoveryEmail?: string;
}

export function loadAccounts(filePath: string): Account[] {
  if (!fs.existsSync(filePath)) return [];
  const accounts: Account[] = [];

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Split on ':' or '|' or ','
    const parts = trimmed.split(/[:|,]/).map((p) => p.trim());
    if (parts.length > 0 && parts[0].includes("@")) {
      accounts.push({
        email: parts[0],
        password: parts[1] || undefined,
        recoveryEmail: parts[2] || undefined,
      });
    }
  }

  return accounts;
}

export function loadProxies(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const proxies: string[] = [];

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    proxies.push(trimmed);
  }

  return proxies;
}
