import fs from "node:fs";

export interface Account {
  email: string;
  password: string;
  recoveryEmail?: string;
}

export function loadAccounts(filePath?: string): Account[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const accounts: Account[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Handles comma, colon, or tab separated accounts
    const parts = trimmed.split(/[:,|\t]/).map((p) => p.trim());
    if (parts.length >= 2) {
      accounts.push({
        email: parts[0],
        password: parts[1],
        recoveryEmail: parts[2] || undefined,
      });
    }
  }

  return accounts;
}

export function loadProxies(filePath?: string): string[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const proxies: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    proxies.push(trimmed);
  }

  return proxies;
}
